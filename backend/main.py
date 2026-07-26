from __future__ import annotations

import json
import math
import os
import re
import smtplib
import time
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from itertools import islice
from typing import Any, Iterable, TypeVar, cast
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

import joblib
import pandas as pd
import shap
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
MODEL_PATH = BASE_DIR / "model.pkl"
ENCODER_PATH = BASE_DIR / "label_encoders.pkl"
METADATA_PATH = BASE_DIR / "model_metadata.json"

APP_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "APP_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173",
    ).split(",")
    if origin.strip()
]
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_REPORT_BUCKET = os.getenv("SUPABASE_REPORT_BUCKET", "roadzen-report-photos")
GMAIL_SMTP_USER = os.getenv("GMAIL_SMTP_USER", "")
GMAIL_SMTP_APP_PASSWORD = os.getenv("GMAIL_SMTP_APP_PASSWORD", "")
REPORT_NOTIFICATION_TO = os.getenv("REPORT_NOTIFICATION_TO", "")

app = FastAPI(title="RoadZen API", version="4.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=APP_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

model = joblib.load(MODEL_PATH)
label_encoders = joblib.load(ENCODER_PATH)
with METADATA_PATH.open("r", encoding="utf-8") as handle:
    model_metadata = json.load(handle)
explainer = shap.TreeExplainer(model)


def load_json(filename: str) -> list[dict[str, Any]]:
    path = BASE_DIR / filename
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


heatmap_data = load_json("heatmap_data.json")
feature_importance = load_json("feature_importance.json")
hourly_stats = load_json("hourly_stats.json")
weather_stats = load_json("weather_stats.json")
vehicle_stats = load_json("vehicle_stats.json")
day_stats = load_json("day_stats.json")
state_stats = load_json("state_stats.json")
casualty_stats = load_json("casualty_stats.json")
recent_incidents = load_json("recent_incidents.json")

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
PRIMARY_MODEL = os.getenv("OLLAMA_PRIMARY_MODEL", "phi3:latest")
SUPPORT_MODEL = os.getenv("OLLAMA_SUPPORT_MODEL", "mistral:latest")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather"

RISK_LABELS = {0: "Minor", 1: "Moderate", 2: "Severe"}
SIMPLE_QUERIES = {
    "hi",
    "hello",
    "hey",
    "yo",
    "help",
    "hii",
    "hello roadzen",
    "hey roadzen",
    "hi roadzen",
}


class TTLCache:
    def __init__(self, maxsize: int = 256, ttl_seconds: int = 300) -> None:
        self.maxsize = maxsize
        self.ttl_seconds = ttl_seconds
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str) -> Any | None:
        item = self._store.get(key)
        if not item:
            return None
        expires_at, value = item
        if expires_at < time.time():
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.time() + self.ttl_seconds, value)
        self._store.move_to_end(key)
        while len(self._store) > self.maxsize:
            self._store.popitem(last=False)


chat_cache = TTLCache(maxsize=512, ttl_seconds=480)
weather_cache = TTLCache(maxsize=128, ttl_seconds=900)
context_cache = TTLCache(maxsize=256, ttl_seconds=600)


class ZoneReportIn(BaseModel):
    title: str = Field(..., min_length=6, max_length=90)
    description: str = Field(..., min_length=20, max_length=900)
    category: str = Field(..., pattern=r"^(accident|congestion|roadwork|hazard|closure)$")
    severity: str = Field(..., pattern=r"^(low|medium|high)$")
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    address: str | None = Field(default=None, max_length=220)

    @field_validator("title", "description", "address")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = re.sub(r"\s+", " ", value).strip()
        if re.search(r"<[^>]+>", cleaned):
            raise ValueError("HTML is not allowed")
        return cleaned


class ReportPhotosIn(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=4)

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, paths: list[str]) -> list[str]:
        safe_paths = []
        for path in paths:
            if not re.fullmatch(r"[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]{1,120}", path):
                raise ValueError("Invalid storage path")
            safe_paths.append(path)
        return safe_paths


def require_supabase() -> None:
    if not (SUPABASE_URL and SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY):
        raise HTTPException(status_code=503, detail="Supabase is not configured")


def extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.removeprefix("Bearer ").strip()
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{20,4096}", token):
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


def request_json(url: str, headers: dict[str, str], method: str = "GET", body: Any | None = None) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib_request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib_request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") or exc.reason
        raise HTTPException(status_code=exc.code, detail=compact_text(detail, 300)) from exc
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=502, detail="Supabase request failed") from exc


def get_current_user(authorization: str | None) -> dict[str, Any]:
    require_supabase()
    token = extract_bearer(authorization)
    user = request_json(
        f"{SUPABASE_URL}/auth/v1/user",
        {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    user_id = user.get("id") if isinstance(user, dict) else None
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid session")
    return user


def supabase_rest(path: str, method: str = "GET", body: Any | None = None, prefer: str = "return=representation") -> Any:
    require_supabase()
    return request_json(
        f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}",
        {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
        method=method,
        body=body,
    )


def send_report_email(report: dict[str, Any], user: dict[str, Any]) -> None:
    if not (GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD and REPORT_NOTIFICATION_TO):
        return
    message = EmailMessage()
    message["Subject"] = f"RoadZen zone report: {report.get('title', 'New report')}"
    message["From"] = GMAIL_SMTP_USER
    message["To"] = REPORT_NOTIFICATION_TO
    user_email = user.get("email") or "unknown user"
    message.set_content(
        "\n".join(
            [
                "A new RoadZen accident-prone zone report was submitted.",
                f"Reporter: {user_email}",
                f"Category: {report.get('category')}",
                f"Severity: {report.get('severity')}",
                f"Coordinates: {report.get('lat')}, {report.get('lng')}",
                f"Title: {report.get('title')}",
                f"Description: {report.get('description')}",
            ]
        )
    )
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(GMAIL_SMTP_USER, GMAIL_SMTP_APP_PASSWORD)
        smtp.send_message(message)


@app.get("/")
def home() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/heatmap")
def heatmap_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "heatmap.html")


@app.get("/dashboard")
def dashboard_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "dashboard.html")


@app.get("/analytics/states")
def analytics_states_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-states.html")


@app.get("/analytics/weather")
def analytics_weather_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-weather.html")


@app.get("/analytics/vehicles")
def analytics_vehicles_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-vehicles.html")


@app.get("/analytics/hourly")
def analytics_hourly_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-hourly.html")


@app.get("/analytics/impact")
def analytics_impact_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-impact.html")


@app.get("/analytics/casualties")
def analytics_casualties_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "analytics-casualties.html")


@app.get("/predict")
def predict_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "predict.html")


@app.get("/chatbot")
def chatbot_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "chatbot.html")


@app.get("/auth")
def auth_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "auth.html")


@app.get("/api/auth/config")
def auth_config() -> dict[str, Any]:
    return {
        "enabled": bool(SUPABASE_URL and SUPABASE_ANON_KEY),
        "url": SUPABASE_URL,
        "anon_key": SUPABASE_ANON_KEY,
        "report_bucket": SUPABASE_REPORT_BUCKET,
    }


@app.get("/api/auth/me")
def auth_me(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user = get_current_user(authorization)
    return {
        "id": user["id"],
        "email": user.get("email"),
        "name": user.get("user_metadata", {}).get("full_name") or user.get("email"),
    }


@app.post("/api/reports")
def create_zone_report(
    report: ZoneReportIn,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_current_user(authorization)
    payload = {
        "user_id": user["id"],
        "title": report.title,
        "description": report.description,
        "category": report.category,
        "severity": report.severity,
        "lat": report.lat,
        "lng": report.lng,
        "address": report.address,
        "status": "pending_review",
        "aggregate_visible": True,
    }
    rows = supabase_rest("zone_reports", method="POST", body=payload)
    created = rows[0] if isinstance(rows, list) and rows else payload
    background_tasks.add_task(send_report_email, created, user)
    return {
        "id": created["id"],
        "status": created.get("status", "pending_review"),
        "storage_prefix": f"{user['id']}/{created['id']}",
    }


@app.post("/api/reports/{report_id}/photos")
def attach_report_photos(
    report_id: str,
    photos: ReportPhotosIn,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = get_current_user(authorization)
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", report_id):
        raise HTTPException(status_code=400, detail="Invalid report id")
    found = supabase_rest(f"zone_reports?id=eq.{report_id}&select=id,user_id", prefer="")
    if not isinstance(found, list) or not found:
        raise HTTPException(status_code=404, detail="Report not found")
    if found[0].get("user_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Report does not belong to this user")
    rows = [
        {
            "report_id": report_id,
            "user_id": user["id"],
            "bucket": SUPABASE_REPORT_BUCKET,
            "storage_path": path,
        }
        for path in photos.paths
    ]
    supabase_rest("report_photos", method="POST", body=rows, prefer="return=minimal")
    return {"attached": len(rows)}


@app.get("/api/reports/mine")
def get_my_reports(authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
    user = get_current_user(authorization)
    rows = supabase_rest(
        f"zone_reports?user_id=eq.{user['id']}&select=id,title,category,severity,status,lat,lng,address,created_at&order=created_at.desc",
        prefer="",
    )
    return rows if isinstance(rows, list) else []


@app.get("/api/reports/aggregate")
def get_report_aggregate() -> list[dict[str, Any]]:
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return []
    rows = supabase_rest(
        "zone_reports?aggregate_visible=eq.true&select=id,category,severity,status,lat,lng,created_at&order=created_at.desc&limit=500",
        prefer="",
    )
    if not isinstance(rows, list):
        return []
    severity_weight = {"high": 1.0, "medium": 0.65, "low": 0.35}
    return [
        {
            "id": row["id"],
            "category": row["category"],
            "severity": row["severity"],
            "status": row["status"],
            "lat": float(row["lat"]),
            "lng": float(row["lng"]),
            "intensity": severity_weight.get(row["severity"], 0.5),
        }
        for row in rows
    ]


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def tokenize(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", value.lower())


def is_basic_greeting(message: str) -> bool:
    return normalize_text(re.sub(r"[^a-zA-Z\s]", "", message)) in SIMPLE_QUERIES


def compact_text(value: str, limit: int) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    max_chars = max(limit - 1, 0)
    truncated = "".join(char for _, char in zip(range(max_chars), value))
    return f"{truncated.rstrip()}…"


T = TypeVar("T")


def take_first(items: Iterable[T], limit: int) -> list[T]:
    return list(islice(items, limit))


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def cache_key(prefix: str, payload: Any) -> str:
    return f"{prefix}:{json.dumps(payload, sort_keys=True, ensure_ascii=True)}"


def encode_payload(data: dict[str, Any]) -> pd.DataFrame:
    features = cast(list[str], model_metadata["features"])
    input_data: dict[str, list[Any]] = {}
    for feature in features:
        plain_feature = feature.replace("_encoded", "")
        if feature in data:
            input_data[feature] = [data[feature]]
            continue
        if plain_feature in data:
            raw_value = str(data[plain_feature])
            if plain_feature in label_encoders:
                encoder = label_encoders[plain_feature]
                known = set(map(str, getattr(encoder, "classes_", [])))
                input_data[feature] = [int(encoder.transform([raw_value])[0]) if raw_value in known else 0]
            else:
                input_data[feature] = [data[plain_feature]]
            continue
        input_data[feature] = [0]
    return pd.DataFrame(input_data)


def predict_payload(data: dict[str, Any]) -> dict[str, Any]:
    frame = encode_payload(data)
    prediction = int(model.predict(frame)[0])
    probabilities = model.predict_proba(frame)[0]
    return {
        "risk_level": prediction,
        "risk_label": RISK_LABELS[prediction],
        "probabilities": {
            RISK_LABELS[index]: float(probabilities[index])
            for index in range(len(probabilities))
        },
        "confidence": float(max(probabilities) * 100),
        "input_summary": build_prediction_summary(data),
    }


def build_prediction_summary(data: dict[str, Any]) -> str:
    pieces = []
    if data.get("weather"):
        pieces.append(f"weather {data['weather']}")
    if data.get("vehicle_type"):
        pieces.append(f"vehicle {data['vehicle_type']}")
    if data.get("lum"):
        pieces.append(f"light {data['lum']}")
    if data.get("hour") is not None:
        pieces.append(f"hour {data['hour']}")
    return ", ".join(pieces) if pieces else "general scenario"


def _impact_narrative(feature: str, impact: float, data: dict[str, Any]) -> str:
    direction = "raises" if impact > 0 else "eases"
    plain = feature.replace("_encoded", "")
    value = data.get(plain, data.get(feature, "current input"))
    return f"{plain.replace('_', ' ')} ({value}) {direction} the predicted severity"


def explain_payload(data: dict[str, Any]) -> dict[str, Any]:
    frame = encode_payload(data)
    shap_values = explainer.shap_values(frame)
    prediction = int(model.predict(frame)[0])
    if isinstance(shap_values, list):
        selected_values = cast(Any, shap_values[prediction][0]).tolist()
    else:
        selected_values = cast(Any, shap_values[0]).tolist()
    ranked: list[tuple[str, float]] = sorted(
        [
            (feature_name, as_float(impact))
            for feature_name, impact in zip(cast(list[str], model_metadata["features"]), selected_values)
        ],
        key=lambda item: abs(item[1]),
        reverse=True,
    )
    top_factors = [
        {
            "feature": feature.replace("_encoded", ""),
            "impact": float(impact),
            "direction": "increases" if impact > 0 else "decreases",
            "narrative": _impact_narrative(feature, float(impact), data),
        }
        for feature, impact in take_first(ranked, 5)
    ]
    explanation = "\n".join(f"- {item['narrative']}" for item in top_factors)
    return {
        "predicted_class": prediction,
        "predicted_label": RISK_LABELS[prediction],
        "top_factors": top_factors,
        "explanation": explanation,
    }


def _top_rows(rows: list[dict[str, Any]], key: str, limit: int = 4) -> list[dict[str, Any]]:
    sorted_rows = sorted(rows, key=lambda item: as_float(item.get(key, 0)), reverse=True)
    return take_first(sorted_rows, limit)


STATE_TOP = _top_rows(state_stats, "accidents")
WEATHER_TOP = _top_rows(weather_stats, "avg_severity")
VEHICLE_TOP = _top_rows(vehicle_stats, "avg_severity")
HOUR_TOP = _top_rows(hourly_stats, "avg_severity")


def pick_relevant_rows(message: str, rows: list[dict[str, Any]], limit: int = 4) -> list[dict[str, Any]]:
    tokens = [token for token in tokenize(message) if len(token) > 2]
    if not tokens:
        return take_first(rows, limit)
    scored: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        text = json.dumps(row, ensure_ascii=True).lower()
        score = sum(token in text for token in tokens)
        if score:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [row for _, row in take_first(scored, limit)]


def build_context_snapshot(message: str) -> dict[str, Any]:
    context_id = cache_key("context", message)
    cached = context_cache.get(context_id)
    if cached:
        return cached

    states = pick_relevant_rows(message, state_stats) or STATE_TOP
    weather = pick_relevant_rows(message, weather_stats) or WEATHER_TOP
    vehicles = pick_relevant_rows(message, vehicle_stats) or VEHICLE_TOP
    incidents = pick_relevant_rows(message, recent_incidents) or take_first(recent_incidents, 3)
    hours = pick_relevant_rows(message, hourly_stats) or HOUR_TOP

    snapshot = {
        "model_accuracy": float(f"{as_float(model_metadata.get('test_accuracy', 0)) * 100:.1f}"),
        "samples": model_metadata.get("n_samples", 0),
        "states": [
            {
                "state": row["state"],
                "code": row["code"],
                "accidents": row["accidents"],
                "fatalities": row["fatalities"],
                "risk": row["risk"],
            }
            for row in take_first(states, 3)
        ],
        "weather": [
            {
                "weather": row["weather"],
                "avg_severity": row["avg_severity"],
                "count": row["count"],
            }
            for row in take_first(weather, 3)
        ],
        "vehicles": [
            {
                "vehicle_type": row["vehicle_type"],
                "avg_severity": row["avg_severity"],
                "count": row["count"],
            }
            for row in take_first(vehicles, 3)
        ],
        "hours": [
            {
                "hour": row["hour"],
                "avg_severity": row["avg_severity"],
                "count": row["count"],
            }
            for row in take_first(hours, 3)
        ],
        "incidents": [
            {
                "date": row["date"],
                "location": row["location"],
                "severity": row["severity"],
                "cause": row["cause"],
            }
            for row in take_first(incidents, 3)
        ],
    }
    context_cache.set(context_id, snapshot)
    return snapshot


def render_context(snapshot: dict[str, Any]) -> str:
    lines = [
        f"Accuracy {snapshot['model_accuracy']}% across {snapshot['samples']} rows.",
        "State signals:",
    ]
    lines.extend(
        f"- {item['state']} ({item['code']}): {item['accidents']} accidents, {item['fatalities']} fatalities, risk {item['risk']}"
        for item in snapshot["states"]
    )
    lines.append("Weather signals:")
    lines.extend(
        f"- {item['weather']}: severity {item['avg_severity']:.2f}, count {item['count']}"
        for item in snapshot["weather"]
    )
    lines.append("Vehicle signals:")
    lines.extend(
        f"- {item['vehicle_type']}: severity {item['avg_severity']:.2f}, count {item['count']}"
        for item in snapshot["vehicles"]
    )
    lines.append("Hour signals:")
    lines.extend(
        f"- {item['hour']}:00 severity {item['avg_severity']:.2f}, count {item['count']}"
        for item in snapshot["hours"]
    )
    lines.append("Recent incidents:")
    lines.extend(
        f"- {item['date']} {item['location']}: severity {item['severity']}, cause {item['cause']}"
        for item in snapshot["incidents"]
    )
    return compact_text("\n".join(lines), 1800)


def query_complexity(message: str) -> str:
    normalized = normalize_text(message)
    tokens = tokenize(message)
    if normalized in SIMPLE_QUERIES or len(tokens) <= 3:
        return "simple"
    complex_markers = {"why", "compare", "difference", "explain", "predict", "risk", "analyze", "breakdown"}
    if len(tokens) >= 14 or any(token in complex_markers for token in tokens):
        return "complex"
    return "standard"


def choose_model(message: str) -> dict[str, Any]:
    complexity = query_complexity(message)
    if complexity == "simple":
        return {"model": PRIMARY_MODEL, "max_tokens": 96, "temperature": 0.25, "num_ctx": 1024}
    if complexity == "complex":
        return {"model": SUPPORT_MODEL, "max_tokens": 320, "temperature": 0.2, "num_ctx": 1536}
    return {"model": PRIMARY_MODEL, "max_tokens": 220, "temperature": 0.2, "num_ctx": 1280}


def build_followups(message: str) -> list[str]:
    text = normalize_text(message)
    if any(word in text for word in ["weather", "rain", "fog", "storm"]):
        return ["Show risky hours", "Compare weather types", "Give driving tips"]
    if any(word in text for word in ["map", "state", "location"]):
        return ["Open heatmap", "Compare two states", "Show recent incidents"]
    if any(word in text for word in ["predict", "risk", "severity"]):
        return ["Explain factors", "How to lower risk", "Show vehicle risks"]
    return ["Top risk states", "Weather risk", "Predict my trip"]


def fallback_chat_reply(message: str) -> str:
    if is_basic_greeting(message):
        return "Hi. How can I help with your trip?"
    lower = message.lower()
    if any(word in lower for word in ["state", "accident"]):
        top = STATE_TOP[0]
        return f"{top['state']} is showing the strongest accident pressure in the current RoadZen signal."
    if any(word in lower for word in ["weather", "rain", "fog"]):
        top = WEATHER_TOP[0]
        return f"{top['weather']} is one of the sharpest weather risk patterns here."
    return "I can help with road risk, map hotspots, trip prediction, and safer driving choices."


def build_system_prompt(message: str) -> str:
    complexity = query_complexity(message)
    if complexity == "simple":
        return (
            "You are RoadZen. Reply in one or two short lines. "
            "Keep greetings crisp. Avoid long paragraphs. Do not mention models, prompts, datasets, tables, or internal sources."
        )
    return (
        "You are RoadZen, a road safety assistant. "
        "Use short paragraphs or bullet-style line breaks. "
        "Stay specific, practical, and natural. Do not mention models, prompts, datasets, tables, or internal sources."
    )


def request_ollama_json(payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib_request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def build_ollama_payload(message: str, stream: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    route = choose_model(message)
    snapshot = build_context_snapshot(message)
    payload = {
        "model": route["model"],
        "stream": stream,
        "messages": [
            {"role": "system", "content": build_system_prompt(message)},
            {"role": "system", "content": render_context(snapshot)},
            {"role": "user", "content": compact_text(message, 900)},
        ],
        "options": {
            "temperature": route["temperature"],
            "top_k": 30,
            "top_p": 0.88,
            "num_ctx": route["num_ctx"],
            "num_predict": route["max_tokens"],
            "repeat_penalty": 1.08,
        },
    }
    return payload, route


def call_chat_model(message: str) -> dict[str, Any]:
    key = cache_key("chat", {"message": normalize_text(message)})
    cached = chat_cache.get(key)
    if cached:
        return {**cached, "cached": True}

    if is_basic_greeting(message):
        result = {
            "reply": "Hi. How can I help with your trip?",
            "suggestions": ["Weather risk", "Open heatmap", "Predict my trip"],
            "model": "RoadZen guidance",
            "cached": True,
        }
        chat_cache.set(key, result)
        return result

    payload, route = build_ollama_payload(message, stream=False)
    try:
        response = request_ollama_json(payload)
        reply = compact_text(response.get("message", {}).get("content", "").strip(), 2200)
        if not reply:
            raise ValueError("Empty model response")
    except (urllib_error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        reply = fallback_chat_reply(message)

    result = {
        "reply": reply,
        "suggestions": build_followups(message),
        "model": "RoadZen guidance",
        "cached": False,
    }
    chat_cache.set(key, result)
    return result


def sse_event(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=True)}\n\n"


def stream_chat_model(message: str):
    key = cache_key("chat", {"message": normalize_text(message)})
    cached = chat_cache.get(key)
    if cached:
        yield sse_event("meta", {"model": cached.get("model", "RoadZen guidance"), "cached": True})
        yield sse_event("chunk", {"text": cached["reply"]})
        yield sse_event("done", {"reply": cached["reply"], "suggestions": cached.get("suggestions", [])})
        return

    if is_basic_greeting(message):
        reply = "Hi. How can I help with your trip?"
        result = {"reply": reply, "suggestions": ["Weather risk", "Open heatmap", "Predict my trip"], "model": PRIMARY_MODEL}
        chat_cache.set(key, result)
        yield sse_event("meta", {"model": "RoadZen guidance", "cached": True})
        yield sse_event("chunk", {"text": reply})
        yield sse_event("done", result)
        return

    payload, route = build_ollama_payload(message, stream=True)
    yield sse_event("meta", {"model": "RoadZen guidance", "cached": False})
    chunks: list[str] = []
    request = urllib_request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=90) as response:
            while True:
                line = response.readline()
                if not line:
                    break
                parsed = json.loads(line.decode("utf-8"))
                text = parsed.get("message", {}).get("content", "")
                if text:
                    chunks.append(text)
                    yield sse_event("chunk", {"text": text})
                if parsed.get("done"):
                    break
        reply = compact_text("".join(chunks).strip(), 2200)
        if not reply:
            raise ValueError("Empty streamed response")
    except (urllib_error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        reply = fallback_chat_reply(message)
        yield sse_event("chunk", {"text": reply})

    result = {
        "reply": reply,
        "suggestions": build_followups(message),
        "model": route["model"],
    }
    chat_cache.set(key, result)
    yield sse_event("done", result)


def fetch_openweather(lat: float, lon: float) -> dict[str, Any]:
    if not OPENWEATHER_API_KEY:
        return {}
    lat_value = as_float(lat)
    lon_value = as_float(lon)
    query = urllib_parse.urlencode(
        {
            "lat": f"{lat_value:.5f}",
            "lon": f"{lon_value:.5f}",
            "appid": OPENWEATHER_API_KEY,
            "units": "metric",
        }
    )
    request = urllib_request.Request(f"{OPENWEATHER_URL}?{query}", method="GET")
    with urllib_request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


@app.post("/api/predict")
def predict(data: dict[str, Any]) -> dict[str, Any]:
    try:
        return predict_payload(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/predict")
def predict_compat(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(predict(data))


@app.post("/api/explain")
def explain(data: dict[str, Any]) -> dict[str, Any]:
    try:
        return explain_payload(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/chat")
def chat(query: dict[str, Any]) -> dict[str, Any]:
    message = query.get("message", "").strip()
    if not message:
        return {
            "reply": "Ask about road risk, weather, hotspots, or trip safety.",
            "suggestions": ["Weather risk", "Open heatmap", "Predict my trip"],
            "model": PRIMARY_MODEL,
            "cached": False,
        }
    return call_chat_model(message)


@app.post("/chat")
def chat_compat(query: dict[str, Any]) -> JSONResponse:
    return JSONResponse(chat(query))


@app.post("/api/chat/stream")
def chat_stream(query: dict[str, Any]) -> StreamingResponse:
    message = query.get("message", "").strip()
    if not message:
        def empty_stream():
            yield sse_event("done", {
                "reply": "Ask about road risk, weather, hotspots, or trip safety.",
                "suggestions": ["Weather risk", "Open heatmap", "Predict my trip"],
                "model": PRIMARY_MODEL,
            })

        return StreamingResponse(empty_stream(), media_type="text/event-stream")
    return StreamingResponse(stream_chat_model(message), media_type="text/event-stream")


@app.get("/api/location-context")
def location_context(lat: float = Query(...), lon: float = Query(...)) -> dict[str, Any]:
    lat_value = as_float(lat)
    lon_value = as_float(lon)
    key = cache_key("weather", {"lat": f"{lat_value:.3f}", "lon": f"{lon_value:.3f}"})
    cached = weather_cache.get(key)
    if cached:
        return cached

    weather = {}
    if OPENWEATHER_API_KEY:
        try:
            weather = fetch_openweather(lat_value, lon_value)
        except Exception:  # noqa: BLE001
            weather = {}

    timezone_offset = int(weather.get("timezone", 0))
    weather_entries = weather.get("weather")
    primary_weather = weather_entries[0] if isinstance(weather_entries, list) and weather_entries else {}
    local_time = datetime.now(UTC) + timedelta(seconds=timezone_offset)
    payload = {
        "coordinates": {"lat": lat_value, "lon": lon_value},
        "location_name": weather.get("name") or "Detected location",
        "temperature_c": weather.get("main", {}).get("temp"),
        "condition": primary_weather.get("main"),
        "description": primary_weather.get("description"),
        "time": local_time.strftime("%I:%M %p"),
        "date": local_time.strftime("%d %b %Y"),
        "timezone_offset": timezone_offset,
    }
    weather_cache.set(key, payload)
    return payload


@app.get("/api/heatmap")
def get_heatmap() -> list[dict[str, Any]]:
    return heatmap_data


@app.get("/api/feature-importance")
def get_feature_importance() -> list[dict[str, Any]]:
    return feature_importance


@app.get("/api/hourly-stats")
def get_hourly_stats() -> list[dict[str, Any]]:
    return hourly_stats


@app.get("/api/weather-stats")
def get_weather_stats() -> list[dict[str, Any]]:
    return weather_stats


@app.get("/api/vehicle-stats")
def get_vehicle_stats() -> list[dict[str, Any]]:
    return vehicle_stats


@app.get("/api/day-stats")
def get_day_stats() -> list[dict[str, Any]]:
    return day_stats


@app.get("/api/state-stats")
def get_state_stats() -> list[dict[str, Any]]:
    return state_stats


@app.get("/api/casualty-stats")
def get_casualty_stats() -> list[dict[str, Any]]:
    return casualty_stats


@app.get("/api/recent-incidents")
def get_recent_incidents() -> list[dict[str, Any]]:
    return recent_incidents


@app.get("/api/model-info")
def get_model_info() -> dict[str, Any]:
    return {
        "accuracy": model_metadata["test_accuracy"],
        "n_samples": model_metadata["n_samples"],
    }


@app.get("/api/ai-models")
def get_ai_models() -> dict[str, Any]:
    return {
        "assistant": "RoadZen guidance",
        "routing": {
            "simple": "fast guidance",
            "standard": "balanced guidance",
            "complex": "deep guidance",
        },
        "strategy": "routes questions by complexity without exposing internal models to users",
    }


@app.get("/api/trauma-centers")
def get_trauma_centers() -> list[dict[str, Any]]:
    return [
        {"name": "AIIMS Trauma Centre", "lat": 28.5672, "lng": 77.21, "type": "Level 1", "city": "Delhi"},
        {"name": "Apollo Hospital Chennai", "lat": 13.0067, "lng": 80.2206, "type": "Level 1", "city": "Chennai"},
        {"name": "Manipal Hospital", "lat": 12.9585, "lng": 77.6484, "type": "Level 1", "city": "Bengaluru"},
        {"name": "NIMS Hyderabad", "lat": 17.3942, "lng": 78.392, "type": "Level 1", "city": "Hyderabad"},
        {"name": "KEM Hospital", "lat": 19.0005, "lng": 72.8424, "type": "Level 1", "city": "Mumbai"},
        {"name": "Amrita Hospital", "lat": 10.037, "lng": 76.306, "type": "Level 2", "city": "Kochi"},
        {"name": "JIPMER", "lat": 11.9573, "lng": 79.7972, "type": "Level 1", "city": "Puducherry"},
        {"name": "CMC Vellore", "lat": 12.9249, "lng": 79.135, "type": "Level 1", "city": "Vellore"},
        {"name": "Sanjay Gandhi Hospital", "lat": 26.8508, "lng": 80.9467, "type": "Level 1", "city": "Lucknow"},
        {"name": "PGIMER", "lat": 30.764, "lng": 76.7764, "type": "Level 1", "city": "Chandigarh"},
        {"name": "Ruby Hall Clinic", "lat": 18.5342, "lng": 73.8938, "type": "Level 2", "city": "Pune"},
        {"name": "Fortis Hospital", "lat": 28.4595, "lng": 77.0722, "type": "Level 2", "city": "Gurugram"},
    ]


@app.post("/api/alert")
def send_alert(data: dict[str, Any]) -> dict[str, Any]:
    lat = float(data.get("lat", 28.61))
    lng = float(data.get("lng", 77.23))

    def distance_km(center: dict[str, Any]) -> float:
        lat1 = math.radians(lat)
        lat2 = math.radians(center["lat"])
        d_lat = lat2 - lat1
        d_lng = math.radians(center["lng"] - lng)
        a = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lng / 2) ** 2
        return 6371 * 2 * math.asin(math.sqrt(a))

    sorted_centers = take_first(sorted(get_trauma_centers(), key=distance_km), 3)
    notified = [
        {
            "hospital": center["name"],
            "city": center["city"],
            "status": "NOTIFIED",
            "eta": f"{max(6, int(distance_km(center) * 2.8))} mins",
            "distance_km": float(f"{distance_km(center):.1f}"),
        }
        for center in sorted_centers
    ]
    return {
        "alert_status": "SENT",
        "ambulance_dispatched": True,
        "estimated_response": f"{min(max(6, int(distance_km(center) * 2.8)) for center in sorted_centers)} mins",
        "notified_centers": notified,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

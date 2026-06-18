import base64
import json
import sys
import time
from dataclasses import asdict, is_dataclass

from nubra_python_sdk.ticker import websocketdata

try:
    import msgspec
except Exception:  # pragma: no cover - optional outside Nubra SDK installs
    msgspec = None


def emit(event, **payload):
    print(json.dumps({"event": event, "received_at_ms": int(time.time() * 1000), **payload}, default=to_json), flush=True)


def to_json(value):
    if is_dataclass(value):
        return asdict(value)
    if msgspec is not None and isinstance(value, msgspec.Struct):
        return msgspec.to_builtins(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def read_config():
    if len(sys.argv) < 2:
        raise ValueError("Missing bridge config.")
    raw = base64.b64decode(sys.argv[1]).decode("utf-8")
    return json.loads(raw)


class TokenClient:
    def __init__(self, config):
        env = str(config.get("environment") or "").lower()
        if "uat" in env:
            self.API_BASE_URL = "https://uatapi.nubra.io"
            self.WEBSOCKET_URL = "wss://uatapi.nubra.io/ws"
            self.WEBSOCKET_URL_BATCH = "wss://uatapi.nubra.io/apibatch/ws"
        else:
            self.API_BASE_URL = "https://api.nubra.io"
            self.WEBSOCKET_URL = "wss://api.nubra.io/ws"
            self.WEBSOCKET_URL_BATCH = "wss://api.nubra.io/apibatch/ws"

        token = str(config.get("token") or "").replace("Bearer ", "").strip()
        device_id = str(config.get("deviceId") or "").strip()
        self.BEARER_TOKEN = token
        self.HEADERS = {
            "Authorization": f"Bearer {token}",
            "x-device-id": device_id,
            "Content-Type": "application/json",
            "x-device-os": "sdk",
        }
        self.token_data = {
            "session_token": token,
            "auth_token": token,
            "x-device-id": device_id,
        }
        self.db_path = "auth_data.db"
        self.totp_login = False
        self.env_path_login = False


def main():
    config = read_config()
    symbol = str(config.get("symbol") or "").upper().strip()
    exchange = str(config.get("exchange") or "NSE").upper().strip()
    interval = str(config.get("interval") or "1m").strip()
    expiry = str(config.get("expiry") or "").strip()
    ref_ids = [str(ref_id).strip() for ref_id in config.get("refIds") or [] if str(ref_id).strip()]

    if not symbol:
        raise ValueError("symbol is required")
    if not config.get("token"):
        raise ValueError("token is required")

    client = TokenClient(config)

    def on_connect(message):
        emit("status", status="connected", message=message)

    def on_close(reason):
        emit("status", status="closed", message=reason)

    def on_error(error):
        emit("error", message=str(error))

    def on_ohlcv_data(message):
        emit("ohlcv", data=to_json(message))

    def on_option_data(message):
        emit("option", data=to_json(message))

    def on_orderbook_data(message):
        emit("orderbook", data=to_json(message))

    def on_greeks_data(message):
        emit("greeks", data=to_json(message))

    socket = websocketdata.NubraDataSocket(
        client=client,
        on_ohlcv_data=on_ohlcv_data,
        on_option_data=on_option_data,
        on_orderbook_data=on_orderbook_data,
        on_greeks_data=on_greeks_data,
        on_connect=on_connect,
        on_close=on_close,
        on_error=on_error,
    )
    socket.connect()
    socket.subscribe([symbol], data_type="ohlcv", interval=interval, exchange=exchange)
    if expiry:
        socket.subscribe([f"{symbol}:{expiry}"], data_type="option", exchange=exchange)
    if ref_ids:
        socket.subscribe(ref_ids, data_type="orderbook")
        socket.subscribe(ref_ids, data_type="greeks", exchange=exchange)
    emit(
        "status",
        status="subscribed",
        symbol=symbol,
        exchange=exchange,
        interval=interval,
        expiry=expiry,
        ref_ids=len(ref_ids),
    )

    try:
        if hasattr(socket, "keep_running"):
            socket.keep_running()
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        socket.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit("error", message=str(exc))
        raise

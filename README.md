# Nubra Spot Chart

Local WebGL chart for Nubra spot and historical OHLC data.

## Run

On a fresh machine, install Node.js, clone this repo, then double-click:

```text
Start Desktop App.cmd
```

The launcher installs dependencies the first time it runs, then builds and opens the desktop app.

```powershell
cmd /c npm start
```

For the browser-only server, run:

```powershell
cmd /c npm run start:web
```

## API Usage

The app reads the Nubra REST API through the local Node proxy in `server.js` to avoid browser CORS issues.

- `GET /optionchains/{instrument}/price` for current spot snapshots.
- `POST /charts/timeseries` for historical OHLC candles.
- `GET /refdata/refdata/{date}?exchange={exchange}` for instrument lookup.

Prices from Nubra are treated as paise/integer exchange units and displayed in rupees. The chart axis and tooltips are formatted in `Asia/Kolkata` time, equivalent to UTC+5:30.

No dependencies are required beyond Node.js.

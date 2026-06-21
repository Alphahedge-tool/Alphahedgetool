// Date / time helpers — market hours, IST formatting, local-input conversion.
// Pure functions — no app state.

export function isMarketHours() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  return (h < 15 || (h === 15 && m < 30));
}

export function msUntilMarketClose() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const close = new Date(ist);
  close.setHours(15, 30, 0, 0);
  return close.getTime() - ist.getTime();
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function todayAt(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

export function dateKey(date) {
  return toLocalInput(date).slice(0, 10);
}

export function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

export function tvTime(ms) {
  return Math.floor(ms / 1000);
}

export function formatIstTime(time) {
  const seconds = typeof time === "number" ? time : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(seconds * 1000));
}

// usage: node cdp.mjs <v1|v2> '<expression JS (peut être async)>'
const [, , vault, expr] = process.argv;
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const t = targets.find(t => t.type === "page" && t.title.includes(`- ${vault} -`) && !t.title.startsWith("Settings"));
if (!t) { console.error("fenêtre introuvable", targets.map(t => t.title)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id !== 1) return;
  const r = m.result;
  if (r.exceptionDetails) console.log("ERREUR:", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  else console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 1));
  ws.close();
});

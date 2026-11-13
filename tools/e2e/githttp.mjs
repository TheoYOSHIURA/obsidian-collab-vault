// Petit serveur git HTTP (git http-backend) qui exige un jeton, comme GitHub.
// usage : node githttp.mjs <dossier-des-dépôts> <port> <jeton>
// Les dépôts sont servis sur http://127.0.0.1:<port>/<nom>.git
import http from "node:http";
import { spawn } from "node:child_process";

const [, , root, port, token] = process.argv;

http
  .createServer((req, res) => {
    // CORS, comme si le téléphone appelait depuis une page web (requestUrl n'en a pas besoin)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.end();

    const auth = req.headers.authorization ?? "";
    const pass = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    if (pass !== token) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      return res.end("jeton invalide");
    }
    const url = new URL(req.url, "http://localhost");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", chunk => {
      if (headersDone) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf("\r\n\r\n");
      if (i < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.slice(0, i).toString().split("\r\n")) {
        const [k, ...v] = line.split(":");
        const val = v.join(":").trim();
        if (k.toLowerCase() === "status") status = parseInt(val, 10);
        else res.setHeader(k, val);
      }
      res.writeHead(status);
      res.write(head.slice(i + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.stderr.on("data", d => process.stderr.write(d));
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`serveur git sur http://127.0.0.1:${port}/`));

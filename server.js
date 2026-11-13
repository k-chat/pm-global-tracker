const express = require("express");
const path = require("node:path");

const app = express();
const root = __dirname;
const port = Number(process.env.PORT) || 3000;

// Declare UTF-8 on every HTML response so curly apostrophes / diacritics render
// correctly instead of turning into â€™ / Â· mojibake.
app.use("/node_modules", express.static(path.join(root, "node_modules")));
app.use(express.static(root, {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.set("Content-Type", "text/html; charset=utf-8");
    }
  },
}));
app.get("/", (_request, response) => {
  response.sendFile(path.join(root, "index.html"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

app.listen(port, () => {
  console.log(`Global Tracker running at http://localhost:${port}`);
});

import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import browse from "./routes/browse.js";
import transactions from "./routes/transactions.js";
import audit from "./routes/audit.js";
import analytics from "./routes/analytics.js";
import mongo from "./routes/mongo.js";

const app = express();
const PORT = Number(process.env.PORT || 5000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());

app.get("/api/health", async (req,res) => res.json({ ok:true, service:"BiteStream API" }));
app.use("/api", browse);
app.use("/api", transactions);
app.use("/api", audit);
app.use("/api/analytics", analytics);
app.use("/api/mongo", mongo);

const webDir = path.join(__dirname, "..", "web");
app.use(express.static(webDir));
app.get("*", (req,res,next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(webDir, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: err.message || "Internal server error",
    detail: process.env.NODE_ENV === "development" ? err.stack : undefined
  });
});

app.listen(PORT, () => console.log(`BiteStream API + web: http://localhost:${PORT}`));

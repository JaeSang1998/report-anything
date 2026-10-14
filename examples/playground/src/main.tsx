import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@report-anything/react/styles.css";
import "./app.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

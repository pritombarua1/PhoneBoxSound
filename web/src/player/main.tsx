import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/shared.css";
import "../styles/player.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: the PixiJS Application must initialise exactly once, and
// StrictMode's double-invoked effects would mount/destroy the renderer twice.
createRoot(document.getElementById("root")!).render(<App />);

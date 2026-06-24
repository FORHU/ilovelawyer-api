// src/server.ts
import app from "./app";

import { PORT } from "./config";

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});

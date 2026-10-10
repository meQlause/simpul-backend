import { createApp } from './app.js';
import { readConfig } from './platform/config/index.js';

const config = readConfig(process.env);

const port = 3000;
const app = createApp(config.PROCESS_ROLE);

app.listen(port);

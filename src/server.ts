import express from 'express';
import { readConfig } from './platform/config/index.js';

readConfig(process.env);

const port = 3000;
const app = express();

app.disable('x-powered-by');
app.listen(port);

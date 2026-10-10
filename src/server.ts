import express from 'express';

const port = 3000;
const app = express();

app.disable('x-powered-by');
app.listen(port);

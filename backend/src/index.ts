import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDb } from './db';
import uploadRouter from './routes/upload';
import injectRouter from './routes/inject';
import historyRouter from './routes/history';
import s3filesRouter from './routes/s3files';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api', uploadRouter);
app.use('/api', injectRouter);
app.use('/api', historyRouter);
app.use('/api', s3filesRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Serve React frontend — must be after all API routes
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

async function start() {
  try {
    await initDb();
    app.listen(port, () => {
      console.log(`DataLoader backend listening on port ${port} [${process.env.NODE_ENV || 'production'}]`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();

import { Router } from 'express';
import { extractUser } from '../middleware/auth';
import { listS3Uploads, getS3Preview, deleteS3Object } from '../s3';

const router = Router();

router.get('/s3/files', extractUser, async (req, res) => {
  try {
    const files = await listS3Uploads();
    res.json(
      files
        .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
        .map((f) => ({
          key: f.key,
          filename: f.key.replace(/^uploads\/\d+_/, ''),
          size_bytes: f.size,
          last_modified: f.lastModified.toISOString(),
        })),
    );
  } catch (err) {
    console.error('S3 list error:', err);
    res.status(500).json({ error: 'Failed to list S3 files' });
  }
});

router.get('/s3/preview', extractUser, async (req, res) => {
  const key = req.query.key as string;
  if (!key || !key.startsWith('uploads/')) {
    res.status(400).json({ error: 'Invalid or missing key' });
    return;
  }
  try {
    const text = await getS3Preview(key);
    res.json({ text });
  } catch (err) {
    console.error('S3 preview error:', err);
    res.status(500).json({ error: 'Failed to preview file' });
  }
});

router.delete('/s3/files', extractUser, async (req, res) => {
  const key = req.query.key as string;
  if (!key || !key.startsWith('uploads/')) {
    res.status(400).json({ error: 'Invalid or missing key' });
    return;
  }
  try {
    await deleteS3Object(key);
    res.json({ deleted: key });
  } catch (err) {
    console.error('S3 delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

export default router;

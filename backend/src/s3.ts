import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable, PassThrough } from 'stream';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });

function bucket(): string {
  if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET env var not set');
  return process.env.S3_BUCKET;
}

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const total = body.length;
  const pass = new PassThrough();
  pass.on('error', () => {}); // prevent unhandled error crash if upload fails mid-stream

  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket(), Key: key, Body: pass, ContentType: contentType, ContentLength: total },
    queueSize: 1,
  });

  if (onProgress) {
    // Stream buffer in ~20 chunks so progress events fire throughout the upload,
    // not just once at the end (which is what httpUploadProgress gives for <5MB files).
    const chunkSize = Math.max(64 * 1024, Math.ceil(total / 20));
    let sent = 0;

    const writeNext = () => {
      if (pass.destroyed || sent >= total) { if (!pass.destroyed) pass.end(); return; }
      const end = Math.min(sent + chunkSize, total);
      const ok = pass.write(body.slice(sent, end));
      sent = end;
      onProgress(sent, total);
      if (ok) setImmediate(writeNext);
      else pass.once('drain', writeNext);
    };
    writeNext();
  } else {
    pass.end(body);
  }

  await upload.done();
}

export async function getS3Stream(key: string): Promise<Readable> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!response.Body) throw new Error('Empty S3 response body');
  return response.Body as unknown as Readable;
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export async function listS3Uploads(): Promise<S3ObjectInfo[]> {
  const result: S3ObjectInfo[] = [];
  let token: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: 'uploads/', ContinuationToken: token }),
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.Size !== undefined && obj.LastModified) {
        result.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified });
      }
    }
    token = resp.NextContinuationToken;
  } while (token);
  return result;
}

export async function getS3ObjectSize(key: string): Promise<number> {
  const resp = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  return resp.ContentLength ?? 0;
}

export async function deleteS3Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function getS3Preview(key: string, maxBytes = 8192): Promise<string> {
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${maxBytes - 1}` }),
  );
  if (!resp.Body) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

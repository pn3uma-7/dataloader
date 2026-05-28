import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

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
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket(), Key: key, Body: body, ContentType: contentType },
  });
  if (onProgress) {
    upload.on('httpUploadProgress', (p) => onProgress(p.loaded ?? 0, p.total ?? body.length));
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

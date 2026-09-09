import { promises as fs } from "node:fs";
import path from "node:path";
import nock from "nock";
import { expect } from "vitest";

// Recording/playback helpers
const isRecording = process.env.RECORD === "true";
const recordingsDir = path.join(__dirname, "recordings");

export function withRecording<T>(testName: string, testFn: () => Promise<T>) {
  if (isRecording) {
    return recordTest(testName, testFn);
  } else {
    return replayTest(testName, testFn);
  }
}

async function recordTest<T>(
  testName: string,
  testFn: () => Promise<T>,
): Promise<T> {
  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
    enable_reqheaders_recording: true,
  });

  const result = await testFn();

  const recordings = nock.recorder.play();
  await fs.mkdir(recordingsDir, { recursive: true });
  const recordingPath = path.join(recordingsDir, `${testName}.json`);
  await fs.writeFile(recordingPath, JSON.stringify(recordings, null, 2));

  nock.recorder.clear();
  return result;
}

async function replayTest<T>(
  testName: string,
  testFn: () => Promise<T>,
): Promise<T> {
  const recordingPath = path.join(recordingsDir, `${testName}.json`);

  const content = await fs.readFile(recordingPath, "utf8");
  const recordings = JSON.parse(content) as nock.Definition[];

  const scopes = nock.define(recordings);

  const result = await testFn();

  scopes.forEach((scope) => {
    expect(scope.isDone()).toBe(true);
  });

  return result;
}

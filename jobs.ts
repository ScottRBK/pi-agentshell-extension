import { randomUUID } from "node:crypto";

export type JobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobActivity {
  readonly type: "text" | "tool_use" | "warning" | "error";
  readonly content: string;
}

export interface JobSnapshot {
  readonly id: string;
  readonly status: JobStatus;
  readonly taskName?: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly activity?: readonly JobActivity[];
  readonly latestActivity?: JobActivity;
}

export interface JobMetadata {
  readonly taskName?: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface StartedJob<T> {
  readonly id: string;
  readonly completion: Promise<T>;
}

interface JobRecord {
  readonly id: string;
  readonly controller: AbortController;
  readonly metadata: JobMetadata;
  readonly activity: JobActivity[];
  activityBytes: number;
  status: JobStatus;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);

    if (bytes + characterBytes > maxBytes) {
      break;
    }

    prefix += character;
    bytes += characterBytes;
  }

  return prefix;
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #maxActivityBytes: number;

  constructor(maxActivityBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maxActivityBytes) || maxActivityBytes <= 0) {
      throw new Error("maxActivityBytes must be a positive safe integer");
    }

    this.#maxActivityBytes = maxActivityBytes;
  }

  start<T>(
    run: (signal: AbortSignal, jobId: string) => Promise<T>,
    metadata: JobMetadata = {},
  ): StartedJob<T> {
    const id = `job-${randomUUID()}`;
    const job: JobRecord = {
      id,
      controller: new AbortController(),
      metadata,
      activity: [],
      activityBytes: 0,
      status: "running",
    };
    const completion = Promise.resolve()
      .then(() => run(job.controller.signal, job.id))
      .then((result) => {
        if (job.status === "running") {
          job.status = "completed";
        }

        return result;
      })
      .catch((error: unknown) => {
        if (job.status !== "cancelled") {
          job.status = "failed";
        }

        throw error;
      });

    this.#jobs.set(id, job);

    return { id, completion };
  }

  #snapshot(job: JobRecord): JobSnapshot {
    const activity = job.activity.map((entry) => ({ ...entry }));

    return {
      id: job.id,
      status: job.status,
      ...job.metadata,
      ...(activity.length > 0
        ? {
          activity,
          latestActivity: activity.at(-1),
        }
        : {}),
    };
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.#jobs.get(id);
    return job === undefined ? undefined : this.#snapshot(job);
  }

  list(): JobSnapshot[] {
    return Array.from(this.#jobs.values(), (job) => this.#snapshot(job));
  }

  recordActivity(id: string, activity: JobActivity): boolean {
    const job = this.#jobs.get(id);

    if (job === undefined || activity.content.length === 0) {
      return false;
    }

    const content = takeUtf8Prefix(
      activity.content,
      this.#maxActivityBytes,
    );
    if (content.length === 0) {
      return false;
    }

    const entry = { ...activity, content };
    const entryBytes = Buffer.byteLength(content);

    while (
      job.activity.length > 0 &&
      job.activityBytes + entryBytes > this.#maxActivityBytes
    ) {
      const removed = job.activity.shift();
      job.activityBytes -= Buffer.byteLength(removed?.content ?? "");
    }

    job.activity.push(entry);
    job.activityBytes += entryBytes;
    return true;
  }

  remove(id: string): boolean {
    const job = this.#jobs.get(id);

    if (job === undefined || job.status === "running") {
      return false;
    }

    return this.#jobs.delete(id);
  }

  cancel(id: string): boolean {
    const job = this.#jobs.get(id);

    if (job === undefined || job.status !== "running") {
      return false;
    }

    job.status = "cancelled";
    job.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const id of this.#jobs.keys()) {
      this.cancel(id);
    }
  }

  clear(): void {
    this.#jobs.clear();
  }
}

import { randomUUID } from "node:crypto";

export type JobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobSnapshot {
  readonly id: string;
  readonly status: JobStatus;
  readonly taskName?: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly effort?: string;
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
  status: JobStatus;
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobRecord>();

  start<T>(
    run: (signal: AbortSignal) => Promise<T>,
    metadata: JobMetadata = {},
  ): StartedJob<T> {
    const id = `job-${randomUUID()}`;
    const job: JobRecord = {
      id,
      controller: new AbortController(),
      metadata,
      status: "running",
    };
    const completion = Promise.resolve()
      .then(() => run(job.controller.signal))
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

  get(id: string): JobSnapshot | undefined {
    const job = this.#jobs.get(id);

    return job === undefined
      ? undefined
      : {
        id: job.id,
        status: job.status,
        ...job.metadata,
      };
  }

  list(): JobSnapshot[] {
    return Array.from(this.#jobs.values(), (job) => ({
      id: job.id,
      status: job.status,
      ...job.metadata,
    }));
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
}

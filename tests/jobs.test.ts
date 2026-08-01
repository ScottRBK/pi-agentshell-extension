import assert from "node:assert/strict";
import { test } from "node:test";

import { JobRegistry } from "../jobs.ts";

test("does not reuse job IDs across registry instances", async () => {
  // Arrange
  const firstRegistry = new JobRegistry();
  const secondRegistry = new JobRegistry();

  // Act
  const first = firstRegistry.start(async (_signal) => undefined);
  const second = secondRegistry.start(async (_signal) => undefined);
  await Promise.all([first.completion, second.completion]);

  // Assert
  assert.notEqual(first.id, second.id);
});

test("starts jobs immediately with unique IDs and running status", async () => {
  // Arrange
  const registry = new JobRegistry();
  const work = Promise.withResolvers<void>();

  // Act
  const first = registry.start(() => work.promise);
  const second = registry.start(() => work.promise);

  // Assert
  assert.notEqual(first.id, second.id);
  assert.equal(registry.get(first.id)?.status, "running");
  assert.equal(registry.get(second.id)?.status, "running");

  work.resolve();
  await Promise.all([first.completion, second.completion]);
});

test("keeps display metadata in job snapshots", async () => {
  // Arrange
  const registry = new JobRegistry();

  // Act
  const job = registry.start(
    async () => "finished",
    {
      taskName: "QA review",
      agentType: "claude_code",
      model: "haiku",
      effort: "medium",
    },
  );

  // Assert
  assert.deepEqual(registry.get(job.id), {
    id: job.id,
    status: "running",
    taskName: "QA review",
    agentType: "claude_code",
    model: "haiku",
    effort: "medium",
  });
  assert.deepEqual(registry.list(), [registry.get(job.id)]);
  await job.completion;
});

test("marks a successful job as completed", async () => {
  // Arrange
  const registry = new JobRegistry();

  // Act
  const job = registry.start(async () => "finished");
  const result = await job.completion;

  // Assert
  assert.equal(result, "finished");
  assert.equal(registry.get(job.id)?.status, "completed");
});

test("marks a failed job as failed and preserves its error", async () => {
  // Arrange
  const registry = new JobRegistry();
  const failure = new Error("worker failed");

  // Act
  const job = registry.start(async () => {
    throw failure;
  });

  // Assert
  await assert.rejects(job.completion, (error) => error === failure);
  assert.equal(registry.get(job.id)?.status, "failed");
});

test("cancels a running job by ID", async () => {
  // Arrange
  const registry = new JobRegistry();
  const started = Promise.withResolvers<void>();
  const failure = new Error("aborted");
  const job = registry.start(async (signal) => {
    started.resolve();

    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(failure), {
        once: true,
      });
    });
  });
  await started.promise;

  // Act
  const cancelled = registry.cancel(job.id);

  // Assert
  assert.equal(cancelled, true);
  await assert.rejects(job.completion, (error) => error === failure);
  assert.equal(registry.get(job.id)?.status, "cancelled");
});

test("keeps cancelled status when work settles late", async () => {
  // Arrange
  const registry = new JobRegistry();
  const work = Promise.withResolvers<string>();
  const job = registry.start((_signal) => work.promise);

  // Act
  registry.cancel(job.id);
  work.resolve("late result");
  await job.completion;

  // Assert
  assert.equal(registry.get(job.id)?.status, "cancelled");
});

test("lists jobs and removes only terminal jobs", async () => {
  // Arrange
  const registry = new JobRegistry();
  const work = Promise.withResolvers<string>();
  const running = registry.start((_signal) => work.promise);
  const completed = registry.start(async (_signal) => "finished");
  await completed.completion;

  // Act
  const listed = registry.list();
  const removedRunning = registry.remove(running.id);
  const removedCompleted = registry.remove(completed.id);
  work.resolve("finished later");
  await running.completion;

  // Assert
  assert.deepEqual(listed, [
    { id: running.id, status: "running" },
    { id: completed.id, status: "completed" },
  ]);
  assert.equal(removedRunning, false);
  assert.equal(removedCompleted, true);
  assert.equal(registry.get(completed.id), undefined);
});

test("cancels all running jobs", async () => {
  // Arrange
  const registry = new JobRegistry();
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstFailure = new Error("first aborted");
  const secondFailure = new Error("second aborted");
  const first = registry.start(async (signal) => {
    firstStarted.resolve();

    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(firstFailure), {
        once: true,
      });
    });
  });
  const second = registry.start(async (signal) => {
    secondStarted.resolve();

    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(secondFailure), {
        once: true,
      });
    });
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);

  // Act
  registry.cancelAll();

  // Assert
  await assert.rejects(first.completion, (error) => {
    return error === firstFailure;
  });
  await assert.rejects(second.completion, (error) => {
    return error === secondFailure;
  });
  assert.equal(registry.get(first.id)?.status, "cancelled");
  assert.equal(registry.get(second.id)?.status, "cancelled");
});

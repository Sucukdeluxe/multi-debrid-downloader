export interface InstallResumeManager {
  isSessionRunning(): boolean;
  stop(options: { parkForRestart: boolean }): void;
  persistNowSync(): void;
  start(): Promise<void> | void;
}

export async function runInstallWithResume<T extends { started: boolean }>(
  manager: InstallResumeManager,
  doInstall: () => Promise<T>
): Promise<T> {
  const wasRunning = manager.isSessionRunning();
  if (wasRunning) {
    manager.stop({ parkForRestart: true });
  }
  manager.persistNowSync();

  const resumeIfParked = async (): Promise<void> => {
    if (wasRunning && !manager.isSessionRunning()) {
      await manager.start();
    }
  };

  try {
    const result = await doInstall();
    if (!result.started) {
      await resumeIfParked();
    }
    return result;
  } catch (error) {
    await resumeIfParked();
    throw error;
  }
}

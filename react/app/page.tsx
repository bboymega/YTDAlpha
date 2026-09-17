"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "bootstrap/dist/css/bootstrap.min.css";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircleNotch,
  faExclamationTriangle,
  faDownload,
  faCheck,
  faPlay,
  faClapperboard,
  faMusic,
  faRotateRight,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

type DownloadStatus =
  | "loading"
  | "extracting"
  | "processing"
  | "merging"
  | "reconnecting"
  | "completed"
  | "error"
  | "failed";

interface DownloadItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  uploader: string;
  audioOnly: boolean;
  status: DownloadStatus;
  progress: number;
  fileSize: number;
  format: string | null;
  createdAt: number;
}

interface DownloadCheckResult {
  ready: boolean;
  gone: boolean;
}

const STORAGE_KEY = "ytdalpha_recent_downloads";
const MAX_RECENT_DOWNLOADS = 20;

export default function VideoConverter() {
  const [url, setUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<DownloadStatus | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [videoTitle, setVideoTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [uploader, setUploader] = useState("");
  const [progression, setProgression] = useState(0);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [format, setFormat] = useState<string | null>(null);
  const [recentDownloads, setRecentDownloads] = useState<
    DownloadItem[]
  >([]);
  const [showRecentDownloads, setShowRecentDownloads] = useState(false);

  const formRef = useRef<HTMLFormElement | null>(null);

  const pollTimers = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});

  const currentTaskIdRef = useRef("");

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "";

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";

    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }

    return `${bytes.toFixed(2)} B`;
  };

  const isTerminalStatus = (value: DownloadStatus) =>
    value === "completed" ||
    value === "failed" ||
    value === "error";

  const isActiveStatus = (value: DownloadStatus) =>
    !isTerminalStatus(value);

  const getStatusClass = (value: DownloadStatus) => {
    switch (value) {
      case "processing":
        return "text-primary";

      case "merging":
        return "text-warning";

      case "reconnecting":
        return "text-secondary";

      case "completed":
        return "text-success";

      case "failed":
      case "error":
        return "text-danger";

      case "extracting":
      case "loading":
      default:
        return "text-primary";
    }
  };

  const getProgressBarClass = (value: DownloadStatus) => {
    switch (value) {
      case "merging":
        return "bg-warning";

      case "reconnecting":
        return "bg-secondary";

      default:
        return "bg-primary";
    }
  };

  const saveRecentDownloads = (items: DownloadItem[]) => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(items.slice(0, MAX_RECENT_DOWNLOADS))
      );
    } catch (err) {
      console.warn("Unable to save recent downloads:", err);
    }
  };

  const addRecentDownload = (item: DownloadItem) => {
    setRecentDownloads((current) => {
      const updated = [
        item,
        ...current.filter((existing) => existing.id !== item.id),
      ].slice(0, MAX_RECENT_DOWNLOADS);

      saveRecentDownloads(updated);
      return updated;
    });
  };

  const updateRecentDownload = (
    id: string,
    updates: Partial<DownloadItem>
  ) => {
    setRecentDownloads((current) => {
      const updated = current.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      );

      saveRecentDownloads(updated);
      return updated;
    });
  };

  const clearPolling = (id: string) => {
    const timer = pollTimers.current[id];

    if (timer) {
      clearTimeout(timer);
      delete pollTimers.current[id];
    }
  };

  const checkDownloadAvailability = useCallback(
    async (
      targetId: string,
      audioOnly: boolean
    ): Promise<DownloadCheckResult> => {
      try {
        const response = await fetch(
          `${siteUrl}/api/download?id=${encodeURIComponent(
            targetId
          )}&audio_only=${audioOnly}`,
          {
            method: "HEAD",
            cache: "no-store",
          }
        );

        if (response.ok) {
          return {
            ready: true,
            gone: false,
          };
        }

        if (response.status === 410) {
          return {
            ready: false,
            gone: true,
          };
        }

        return {
          ready: false,
          gone: false,
        };
      } catch (err) {
        console.warn("Download HEAD check failed:", err);

        return {
          ready: false,
          gone: false,
        };
      }
    },
    [siteUrl]
  );

  const markTaskAsFailed = (targetId: string) => {
    updateRecentDownload(targetId, {
      status: "failed",
      progress: 0,
      fileSize: 0,
      format: null,
    });

    if (currentTaskIdRef.current === targetId) {
      setStatus("failed");
      setProgression(0);
      setFileSize(0);
      setFormat(null);
      setIsProcessing(false);
    }

    clearPolling(targetId);
  };

  const startPolling = useCallback(
    (targetId: string, audioOnly: boolean) => {
      clearPolling(targetId);

      const poll = async () => {
        try {
          const response = await fetch(
            `${siteUrl}/api/status?id=${encodeURIComponent(
              targetId
            )}&audio_only=${audioOnly}`,
            {
              cache: "no-store",
            }
          );

          if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
          }

          const data = await response.json();

          const newStatus = data.status as DownloadStatus;
          const newProgress = Number(data.percent ?? 0);
          const newFileSize = Number(data.current_size ?? 0);
          const newFormat = data.format || null;

          if (
            newStatus === "failed" ||
            newStatus === "error"
          ) {
            updateRecentDownload(targetId, {
              status: newStatus,
              progress: newProgress,
              fileSize: newFileSize,
              format: newFormat,
            });

            if (currentTaskIdRef.current === targetId) {
              setStatus(newStatus);
              setProgression(newProgress);
              setFileSize(newFileSize);
              setFormat(newFormat);
              setIsProcessing(false);
            }

            clearPolling(targetId);
            return;
          }

          if (newStatus === "completed") {
            const downloadCheck =
              await checkDownloadAvailability(
                targetId,
                audioOnly
              );

            if (downloadCheck.ready) {
              updateRecentDownload(targetId, {
                status: "completed",
                progress: 100,
                fileSize: newFileSize,
                format: newFormat,
              });

              if (currentTaskIdRef.current === targetId) {
                setStatus("completed");
                setProgression(100);
                setFileSize(newFileSize);
                setFormat(newFormat);
                setIsProcessing(false);
              }

              clearPolling(targetId);
              return;
            }

            if (downloadCheck.gone) {
              markTaskAsFailed(targetId);
              return;
            }

            updateRecentDownload(targetId, {
              status: "merging",
              progress: 100,
              fileSize: newFileSize,
              format: newFormat,
            });

            if (currentTaskIdRef.current === targetId) {
              setStatus("merging");
              setProgression(100);
              setFileSize(newFileSize);
              setFormat(newFormat);
              setIsProcessing(true);
            }

            pollTimers.current[targetId] = setTimeout(poll, 2000);
            return;
          }

          updateRecentDownload(targetId, {
            status: newStatus,
            progress: newProgress,
            fileSize: newFileSize,
            format: newFormat,
          });

          if (currentTaskIdRef.current === targetId) {
            setStatus(newStatus);
            setProgression(newProgress);
            setFileSize(newFileSize);
            setFormat(newFormat);
            setIsProcessing(true);
          }

          pollTimers.current[targetId] = setTimeout(poll, 2000);
        } catch (err) {
          console.warn(
            `Polling error for ${targetId}:`,
            err
          );

          updateRecentDownload(targetId, {
            status: "reconnecting",
          });

          if (currentTaskIdRef.current === targetId) {
            setStatus("reconnecting");
            setIsProcessing(true);
          }

          pollTimers.current[targetId] = setTimeout(poll, 5000);
        }
      };

      poll();
    },
    [checkDownloadAvailability, siteUrl]
  );

  useEffect(() => {
    let storedItems: DownloadItem[] = [];

    try {
      const stored = localStorage.getItem(STORAGE_KEY);

      if (stored) {
        const parsed = JSON.parse(stored);

        if (Array.isArray(parsed)) {
          storedItems = parsed;
        }
      }
    } catch (err) {
      console.warn(
        "Unable to restore recent downloads:",
        err
      );
    }

    if (storedItems.length > 0) {
      setRecentDownloads(storedItems);

      storedItems.forEach((item) => {
        startPolling(item.id, item.audioOnly);
      });
    }

    return () => {
      Object.values(pollTimers.current).forEach((timer) =>
        clearTimeout(timer)
      );

      pollTimers.current = {};
    };
  }, [startPolling]);

  const handleSubmit = async (
    event?: React.SyntheticEvent<HTMLFormElement>
  ) => {
    event?.preventDefault();

    const submittedUrl = url.trim();

    if (!submittedUrl) return;

    setError(null);
    setStatus("loading");
    setProgression(0);
    setFileSize(0);
    setFormat(null);
    setThumbnailUrl("");
    setVideoTitle(null);
    setUploader("");
    setIsProcessing(true);

    try {
      const response = await fetch(`${siteUrl}/api/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: submittedUrl,
          audio_only: isAudioOnly,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message || `Error: ${response.status}`
        );
      }

      const newId = data.url_id;

      currentTaskIdRef.current = newId;

      setVideoTitle(data.title || "Untitled");
      setThumbnailUrl(data.thumbnail || "");
      setUploader(data.uploader || "");
      setStatus("loading");

      addRecentDownload({
        id: newId,
        url: submittedUrl,
        title: data.title || "Untitled",
        thumbnail: data.thumbnail || "",
        uploader: data.uploader || "",
        audioOnly: isAudioOnly,
        status: "loading",
        progress: 0,
        fileSize: 0,
        format: null,
        createdAt: Date.now(),
      });

      startPolling(newId, isAudioOnly);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }

      setIsProcessing(false);
      setStatus(null);
      setThumbnailUrl("");
      setProgression(0);
      setFileSize(0);
      setFormat(null);
    }
  };

  const handleConvertAgain = (item: DownloadItem) => {
    setUrl(item.url);
    setIsAudioOnly(item.audioOnly);
    setError(null);

    setTimeout(() => {
      formRef.current?.requestSubmit();
    }, 0);
  };

  const handleDownload = async (item: DownloadItem) => {
    setError(null);

    const result = await checkDownloadAvailability(
      item.id,
      item.audioOnly
    );

    if (result.gone) {
      markTaskAsFailed(item.id);
      return;
    }

    if (!result.ready) {
      markTaskAsFailed(item.id);

      setError(
        "The download is no longer available. Please convert it again."
      );

      return;
    }

    const downloadUrl =
      `${siteUrl}/api/download?id=${encodeURIComponent(
        item.id
      )}&audio_only=${item.audioOnly}`;

    window.location.href = downloadUrl;
  };

  /*
   * Dismissing history only removes the item from the
   * recent-history list/localStorage.
   *
   * It deliberately does NOT:
   * - clear the active conversion
   * - clear currentTaskIdRef
   * - stop polling
   * - modify the current conversion state
   */
  const dismissHistoryItem = (id: string) => {
    setRecentDownloads((current) => {
      const updated = current.filter(
        (item) => item.id !== id
      );

      saveRecentDownloads(updated);
      return updated;
    });
  };

  const clearHistory = () => {
    setRecentDownloads((current) => {
      saveRecentDownloads([]);
      return current.length === 0 ? current : [];
    });
  };

  /*
   * Shared card style.
   *
   * The conversion status card and recent-history cards use
   * the same visual component. The only difference is that
   * the active conversion card has no dismiss button.
   */
  const DownloadItemCard = ({
    item,
    showDismiss = false,
  }: {
    item: DownloadItem;
    showDismiss?: boolean;
  }) => {
    const progress = Math.min(
      100,
      Math.max(0, item.progress)
    );

    const statusClass = getStatusClass(item.status);

    return (
      <div className="card shadow-sm border-0">
        <div className="card-body p-3">
          <div className="d-flex align-items-center">
            {/* Thumbnail */}
            <div
              className="rounded me-3 bg-dark d-flex align-items-center justify-content-center text-white"
              style={{
                width: "64px",
                height: "64px",
                flexShrink: 0,
                overflow: "hidden",
                position: "relative",
              }}
            >
              {item.thumbnail ? (
                <img
                  src={`https://wsrv.nl/?url=${encodeURIComponent(
                    item.thumbnail
                  )}`}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <FontAwesomeIcon
                  icon={
                    item.audioOnly
                      ? faMusic
                      : faClapperboard
                  }
                />
              )}

              {isActiveStatus(item.status) && (
                <div
                  className="position-absolute top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
                  style={{
                    backgroundColor:
                      "rgba(0,0,0,0.4)",
                  }}
                >
                  <FontAwesomeIcon
                    icon={faCircleNotch}
                    spin
                    className="text-white"
                  />
                </div>
              )}

              {(item.status === "failed" ||
                item.status === "error") && (
                <div
                  className="position-absolute top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
                  style={{
                    backgroundColor:
                      "rgba(220,53,69,0.55)",
                  }}
                >
                  <FontAwesomeIcon
                    icon={faExclamationTriangle}
                    className="text-white"
                  />
                </div>
              )}

              {item.status === "completed" && (
                <div
                  className="position-absolute top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
                  style={{
                    backgroundColor:
                      "rgba(0,0,0,0.2)",
                  }}
                >
                  <FontAwesomeIcon
                    icon={faCheck}
                    className="text-white"
                  />
                </div>
              )}
            </div>

            {/* Information */}
            <div className="flex-grow-1 overflow-hidden me-2">
              <div
                className="fw-semibold text-truncate"
                title={item.title}
              >
                {item.title}
              </div>

              <div className="small text-muted text-truncate">
                {item.uploader}
              </div>

              <div className={`small mt-1 ${statusClass}`}>
                {item.status === "loading" && (
                  <span className="d-flex align-items-center">
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      className="me-1"
                    />
                    Initializing...
                  </span>
                )}

                {item.status === "extracting" && (
                  <span className="d-flex align-items-center text-dark">
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      className="me-1 text-primary"
                    />
                    Extracting URL...
                  </span>
                )}

                {item.status === "processing" && (
                  <span className="d-flex align-items-center text-dark">
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      className="me-1 text-primary"
                    />
                    Converting: {item.progress}%
                  </span>
                )}

                {item.status === "merging" && (
                  <span className="d-flex align-items-center">
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      className="me-1"
                    />
                    Merging...
                  </span>
                )}

                {item.status === "reconnecting" && (
                  <span className="d-flex align-items-center">
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      className="me-1"
                    />
                    Reconnecting...
                  </span>
                )}

                {item.status === "completed" && (
                  <span className="d-flex align-items-center">
                    <FontAwesomeIcon
                      icon={faCheck}
                      className="me-1"
                    />
                    Ready
                    {item.fileSize > 0 &&
                      ` (${formatSize(item.fileSize)})`}
                    {item.format &&
                      `, ${item.format}`}
                  </span>
                )}

                {(item.status === "failed" ||
                  item.status === "error") && (
                  <span className="d-flex align-items-center">
                    <FontAwesomeIcon
                      icon={faExclamationTriangle}
                      className="me-1"
                    />
                    Conversion failed
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div
              className="d-flex align-items-center gap-2"
              style={{
                flexShrink: 0,
              }}
            >
              {item.status === "completed" && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-dark"
                  onClick={() =>
                    handleDownload(item)
                  }
                >
                  <FontAwesomeIcon
                    icon={faDownload}
                    className="me-1"
                  />

                  <span className="d-none d-sm-inline">
                    Download
                  </span>
                </button>
              )}

              {(item.status === "failed" ||
                item.status === "error") && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-dark"
                  onClick={() =>
                    handleConvertAgain(item)
                  }
                >
                  <FontAwesomeIcon
                    icon={faRotateRight}
                    className="me-1"
                  />

                  <span className="d-none d-sm-inline">
                    Convert Again
                  </span>
                </button>
              )}

              {/* X exists ONLY on recent-history cards */}
              {showDismiss && (
                <button
                  type="button"
                  className="btn btn-sm btn-link text-muted p-1"
                  aria-label={`Dismiss ${item.title}`}
                  title="Dismiss"
                  onClick={() =>
                    dismissHistoryItem(item.id)
                  }
                  style={{
                    lineHeight: 1,
                    textDecoration: "none",
                  }}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              )}
            </div>
          </div>

          {/* Progress */}
          {isActiveStatus(item.status) && (
            <div className="mt-2">
              <div
                className="progress"
                style={{ height: "4px" }}
              >
                <div
                  className={`progress-bar ${getProgressBarClass(
                    item.status
                  )}`}
                  role="progressbar"
                  style={{
                    width: `${progress}%`,
                  }}
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  /*
   * The active task is derived from the current task ID.
   *
   * IMPORTANT:
   * This is independent of recentDownloads being displayed.
   * Therefore dismissing a history item cannot remove the
   * current conversion card.
   */
  const activeItem = recentDownloads.find(
    (item) => item.id === currentTaskIdRef.current
  );

  /*
   * If the active item has been dismissed from history,
   * create a separate current-status object from the active
   * React state so the conversion card remains visible.
   */
  const currentConversionItem: DownloadItem | null =
    activeItem ||
    (currentTaskIdRef.current
      ? {
          id: currentTaskIdRef.current,
          url,
          title: videoTitle || "Loading...",
          thumbnail: thumbnailUrl,
          uploader,
          audioOnly: isAudioOnly,
          status: status || "loading",
          progress: progression,
          fileSize,
          format,
          createdAt: Date.now(),
        }
      : null);

  return (
    <div
      className="container-fluid min-vh-100 py-5 d-flex flex-column"
      style={{
        backgroundColor: "#fffbfa",
      }}
    >
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6">
          {/* Header */}
          <div className="text-center mb-5">
            <h1 className="display-5 fw-bold text-dark">
              YTDAlpha
            </h1>

            <span className="text-muted">
              Simple, clean, no pledging and no hazing.
            </span>
          </div>

          {/* Search */}
          <div className="card shadow border-0 p-3 p-md-4 mb-4">
            <form
              ref={formRef}
              onSubmit={handleSubmit}
            >
              <div className="input-group">
                <input
                  type="url"
                  className="form-control form-control-lg border-primary-subtle"
                  placeholder="Just paste a URL and let it cook..."
                  value={url}
                  onChange={(e) =>
                    setUrl(e.target.value)
                  }
                  disabled={isProcessing}
                  required
                  autoFocus
                  onClick={(e) =>
                    (
                      e.target as HTMLInputElement
                    ).select()
                  }
                  style={{
                    height: "48px",
                  }}
                />

                <button
                  className="btn btn-dark d-flex align-items-center justify-content-center"
                  type="submit"
                  disabled={isProcessing}
                  style={{
                    width: "48px",
                    height: "48px",
                    flexShrink: 0,
                  }}
                >
                  {isProcessing ? (
                    <FontAwesomeIcon
                      icon={faCircleNotch}
                      spin
                      style={{
                        width: "1rem",
                      }}
                    />
                  ) : (
                    <FontAwesomeIcon
                      icon={faPlay}
                      style={{
                        width: "1rem",
                      }}
                    />
                  )}
                </button>
              </div>

              {/* Format selector */}
              <div className="mt-3 d-flex gap-3 justify-content-center">
                <div className="form-check form-check-inline">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="formatOptions"
                    id="videoOption"
                    checked={!isAudioOnly}
                    onChange={() =>
                      setIsAudioOnly(false)
                    }
                    disabled={isProcessing}
                  />

                  <label
                    className="form-check-label text-secondary"
                    htmlFor="videoOption"
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: "1rem",
                        height: "1rem",
                        marginRight: "0.5rem",
                      }}
                    >
                      <FontAwesomeIcon
                        icon={faClapperboard}
                      />
                    </span>
                    Video
                  </label>
                </div>

                <div className="form-check form-check-inline">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="formatOptions"
                    id="audioOption"
                    checked={isAudioOnly}
                    onChange={() =>
                      setIsAudioOnly(true)
                    }
                    disabled={isProcessing}
                  />

                  <label
                    className="form-check-label text-secondary"
                    htmlFor="audioOption"
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: "1rem",
                        height: "1rem",
                        marginRight: "0.5rem",
                      }}
                    >
                      <FontAwesomeIcon
                        icon={faMusic}
                      />
                    </span>
                    Audio (MP3)
                  </label>
                </div>
              </div>
            </form>
          </div>

          {/* Error */}
          {error && (
            <div
              className="alert alert-danger alert-dismissible fade show d-flex align-items-center"
              role="alert"
            >
              <FontAwesomeIcon
                icon={faExclamationTriangle}
                className="me-2"
              />

              <div>
                <strong>Error:</strong>{" "}
                {error}
              </div>

              <button
                type="button"
                className="btn-close"
                onClick={() =>
                  setError(null)
                }
              />
            </div>
          )}

          {/* ==================================================
              CURRENT CONVERSION STATUS

              Same visual card as history, but NO dismiss X.
              ================================================== */}
          {currentConversionItem && (
            <div className="mb-4">
              <DownloadItemCard
                item={currentConversionItem}
                showDismiss={false}
              />
            </div>
          )}

          {/* ==================================================
              RECENT DOWNLOAD HISTORY

              Dismissing one of these only removes it from
              history/localStorage. It never changes the
              current conversion status.
              ================================================== */}
          {recentDownloads.length > 0 && (
            <div className="mt-4">
              <div className="d-flex align-items-center justify-content-between mb-3">
                <button
                  type="button"
                  className="btn btn-link text-dark text-decoration-none p-0 fw-semibold"
                  onClick={() =>
                    setShowRecentDownloads((current) => !current)
                  }
                  aria-expanded={showRecentDownloads}
                >
                  <span className="me-2">
                    {showRecentDownloads ? "▲" : "▼"}
                  </span>
                  Recent Downloads
                </button>

                <button
                  type="button"
                  className="btn btn-sm btn-link text-muted text-decoration-none"
                  onClick={clearHistory}
                >
                  Clear
                </button>
              </div>

              {showRecentDownloads && (
                <div
                  className="d-flex flex-column gap-2"
                  style={{
                    maxHeight: "520px",
                    overflowY: "auto",
                    overflowX: "hidden",
                    paddingRight: "4px",
                  }}
                >
                  {recentDownloads.map((item) => (
                    <DownloadItemCard
                      key={item.id}
                      item={item}
                      showDismiss={true}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="py-4 mt-auto border-top">
        <div className="container text-center">
          <p className="text-muted mb-0 small">
            Because sometimes you just want the video
            without{" "}
            <b>writing a CLI thesis</b>.
          </p>
        </div>
      </footer>
    </div>
  );
}

/*
 * Copyright (C) 2026  Romain Lathuiliere
 * * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { useState, useEffect, useRef, memo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Plus,
  FolderOpen,
  FileUp,
  CheckCircle,
  X,
  Trash2,
  Zap,
  Loader2,
  AlertCircle,
  Image as ImageIcon,
  Check,
  PartyPopper,
} from "lucide-react";
import "./App.css";
import { downloadDir } from "@tauri-apps/api/path";

// --- TYPES ---
interface CompressConfig {
  paths: string[];
  output_dir: string;
  format: string;
  quality: number;
  max_width: number | null;
  max_height: number | null;
  prefix: string | null;
  suffix: string | null;
  custom_names: Record<string, string> | null;
}

interface ProcessResult {
  original: string;
  status: "success" | "error";
  error_msg: string | null;
  new_path: string | null;
}

interface PreviewResult {
  path: string;
  original_size: number;
  preview_size: number;
}

interface FileItem {
  path: string;
  name: string;
  extension: string;
  originalSize?: number;
  previewSize?: number;
  width?: number;
  height?: number;
}

type FileStatus = "idle" | "processing" | "success" | "error";

// Helper formatting
const formatBytes = (bytes?: number) => {
  if (bytes === undefined) return "--";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

// --- OPTIMIZED ROW COMPONENT ---
const FileItemRow = memo(
  ({
    file,
    status,
    onRemove,
  }: {
    file: FileItem;
    status: FileStatus;
    onRemove: () => void;
  }) => {
    let gain = null;
    if (file.originalSize && file.previewSize) {
      const diff = file.originalSize - file.previewSize;
      const percent = Math.round((diff / file.originalSize) * 100);
      gain = percent;
    }

    return (
      <div className="file-item" style={{ gap: 15 }}>
        {" "}
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 8,
            overflow: "hidden",
            flexShrink: 0,
            background: "#f1f5f9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ImageIcon size={20} color="#94a3b8" />
        </div>
        <div className="file-text-content" style={{ flex: 1, minWidth: 0 }}>
          <div className="file-name" style={{ marginBottom: 4 }}>
            {file.name}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: "0.65rem",
                fontWeight: 700,
                color: "#64748b",
                background: "#f1f5f9",
                padding: "1px 4px",
                borderRadius: 4,
                textTransform: "uppercase",
              }}
            >
              {file.extension.replace(".", "")}
            </span>

            {file.width && file.height && (
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "#94a3b8",
                  fontFamily: "monospace",
                }}
              >
                {file.width}×{file.height}
              </span>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: "0.7rem",
              color: "#94a3b8",
              textDecoration: file.previewSize ? "line-through" : "none",
            }}
          >
            {formatBytes(file.originalSize)}
          </div>

          {file.previewSize && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {gain !== null && gain > 0 ? (
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: "#16a34a",
                  }}
                >
                  -{gain}%
                </span>
              ) : (
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: "#d00b0bff",
                  }}
                >
                  +{gain?.toString().replace("-", "")}%
                </span>
              )}
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 700,
                  color: "#0f172a",
                }}
              >
                {formatBytes(file.previewSize)}
              </span>
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            paddingLeft: 10,
            borderLeft: "1px solid #f1f5f9",
          }}
        >
          {status === "processing" && (
            <Loader2 size={18} className="spin" color="#3b82f6" />
          )}
          {status === "success" && <CheckCircle size={18} color="#10b981" />}
          {status === "error" && <AlertCircle size={18} color="#ef4444" />}

          {status === "idle" && (
            <button
              onClick={onRemove}
              className="icon-btn"
              style={{
                color: "#cbd5e1",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 4,
              }}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.status === next.status &&
      prev.file.previewSize === next.file.previewSize &&
      prev.file.path === next.file.path &&
      prev.file.originalSize === next.file.originalSize
    );
  },
);

function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [outputDir, setOutputDir] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMap, setStatusMap] = useState<Record<string, FileStatus>>({});
  const [processedCount, setProcessedCount] = useState(0);
  const [isSuccess, setIsSuccess] = useState(false);

  const unlisteners = useRef<UnlistenFn[]>([]);

  // Settings
  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState<string>("");
  const [maxHeight, setMaxHeight] = useState<string>("");

  const cleanupListeners = () => {
    unlisteners.current.forEach((f) => f());
    unlisteners.current = [];
  };

  useEffect(() => {
    let u1: UnlistenFn, u2: UnlistenFn, u3: UnlistenFn;
    const init = async () => {
      u1 = await listen("tauri://file-drop-hover", () => {});
      u2 = await listen("tauri://file-drop-cancelled", () => {});
      u3 = await listen("tauri://file-drop", (e) => {
        const paths = e.payload as string[];
        if (paths?.length) addFiles(paths);
      });
    };
    init();
    return () => {
      if (u1) u1();
      if (u2) u2();
      if (u3) u3();
    };
  }, []);

  useEffect(() => {
    const initDefaultDir = async () => {
      try {
        const defaultPath = await downloadDir();
        setOutputDir(defaultPath);
      } catch (err) {
        console.error("Error getting download dir:", err);
      }
    };
    initDefaultDir();
  }, []);

  useEffect(() => {
    if (files.length === 0) return;
    if (isSuccess) setIsSuccess(false);

    const timer = setTimeout(() => {
      runSimulation();
    }, 600);
    return () => clearTimeout(timer);
  }, [quality, format, maxWidth, maxHeight, files.length]);

  const addFiles = async (newPaths: string[]) => {
    setIsSuccess(false);

    const currentPaths = new Set(files.map((f) => f.path));
    const uniquePaths = newPaths.filter(
      (p) => !currentPaths.has(p) && /\.(jpg|jpeg|png|webp|avif)$/i.test(p),
    );

    if (uniquePaths.length === 0) return;

    const newItems: FileItem[] = uniquePaths.map((path) => {
      const name = path.split(/[\\/]/).pop() || "image";
      return {
        path,
        name: name.substring(0, name.lastIndexOf(".")),
        extension: name.substring(name.lastIndexOf(".")),
      };
    });

    setFiles((prev) => [...prev, ...newItems]);

    try {
      interface MetadataResponse {
        path: string;
        width: number;
        height: number;
        size: number;
      }

      const metadata = await invoke<MetadataResponse[]>("get_images_metadata", {
        paths: uniquePaths,
      });

      setFiles((prev) =>
        prev.map((f) => {
          const meta = metadata.find((m) => m.path === f.path);
          if (meta) {
            return {
              ...f,
              width: meta.width,
              height: meta.height,
              originalSize: meta.size,
            };
          }
          return f;
        }),
      );
    } catch (e) {
      console.error("Erreur metadata", e);
    }
  };

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setIsSuccess(false);
  }, []);

  const clearFiles = () => {
    setFiles([]);
    setStatusMap({});
    setProcessedCount(0);
    setIsSuccess(false);
  };

  const selectFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected && Array.isArray(selected)) addFiles(selected as string[]);
  };

  const selectOutputDir = async () => {
    const selected = await open({ directory: true });
    if (selected) setOutputDir(selected as string);
  };

  const runSimulation = async () => {
    const subsetFiles = files.slice(0, 3);
    if (subsetFiles.length === 0) return;

    const config: CompressConfig = {
      paths: subsetFiles.map((f) => f.path),
      output_dir: "",
      format,
      quality: Number(quality),
      max_width: maxWidth ? Number(maxWidth) : null,
      max_height: maxHeight ? Number(maxHeight) : null,
      prefix: null,
      suffix: null,
      custom_names: null,
    };

    const unlisten = await listen<PreviewResult[]>("preview-done", (event) => {
      const results = event.payload;
      setFiles((currentFiles) =>
        currentFiles.map((f) => {
          const res = results.find((r) => r.path === f.path);
          if (res) {
            return {
              ...f,
              originalSize: res.original_size,
              previewSize: res.preview_size,
            };
          }
          return f;
        }),
      );
      unlisten();
    });

    try {
      await invoke("preview_images", { config });
    } catch (e) {
      console.error(e);
    }
  };

  const startCompression = async () => {
    if (files.length === 0 || !outputDir) return;
    cleanupListeners();
    setIsProcessing(true);
    setIsSuccess(false);
    setProcessedCount(0);
    setStatusMap({});

    const config: CompressConfig = {
      paths: files.map((f) => f.path),
      output_dir: outputDir,
      format,
      quality: Number(quality),
      max_width: maxWidth ? Number(maxWidth) : null,
      max_height: maxHeight ? Number(maxHeight) : null,
      prefix: null,
      suffix: null,
      custom_names: null,
    };

    try {
      const u1 = await listen<string>("img-start", (e) =>
        setStatusMap((p) => ({ ...p, [e.payload]: "processing" })),
      );
      unlisteners.current.push(u1);

      const u2 = await listen<ProcessResult>("img-processed", (e) => {
        setStatusMap((p) => ({
          ...p,
          [e.payload.original]: e.payload.status as FileStatus,
        }));
        if (e.payload.status === "success") {
          setProcessedCount((p) => p + 1);
        }
      });
      unlisteners.current.push(u2);

      const u3 = await listen("batch-finished", () => {
        setIsProcessing(false);
        setIsSuccess(true);
        cleanupListeners();
      });
      unlisteners.current.push(u3);

      await invoke("compress_images", { config });
    } catch (error) {
      console.error(error);
      setIsProcessing(false);
      cleanupListeners();
    }
  };

  const totalSaved = files.reduce((acc, file) => {
    if (
      statusMap[file.path] === "success" &&
      file.originalSize &&
      file.previewSize
    ) {
      return acc + (file.originalSize - file.previewSize);
    }
    return acc;
  }, 0);

  return (
    <div className="app-layout">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="brand">
          <div
            style={{
              background: "#d1fae5",
              padding: 8,
              borderRadius: 12,
              color: "#10b981",
            }}
          >
            <Zap size={24} fill="#10b981" />
          </div>
          <span>Rimages</span>
        </div>

        <div className="control-group">
          <label className="label-title">Save Destination</label>
          <button className="btn-secondary" onClick={selectOutputDir}>
            <FolderOpen size={20} color="#64748b" />
            <span className="truncate-text">
              {outputDir ? outputDir.split(/[\\/]/).pop() : "Choose folder..."}
            </span>
          </button>
        </div>

        <hr className="divider" />

        <div className="control-group">
          <label className="label-title">Output Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="select-big"
          >
            <option value="webp">WebP</option>
            <option value="avif">AVIF</option>
            <option value="jpg">JPEG</option>
            <option value="png">PNG</option>
          </select>
        </div>

        <div className="control-group">
          <div className="flex-between">
            <label className="label-title">Quality</label>
            <span className="value-display">{quality}%</span>
          </div>
          <input
            type="range"
            min="10"
            max="100"
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </div>

        <div className="control-group">
          <label className="label-title">Dimensions (Max)</label>
          <div className="dimensions-grid">
            <input
              type="number"
              placeholder="Width"
              value={maxWidth}
              onChange={(e) => setMaxWidth(e.target.value)}
            />
            <input
              type="number"
              placeholder="Height"
              value={maxHeight}
              onChange={(e) => setMaxHeight(e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginTop: "auto", width: "100%" }}>
          <button
            className="btn-primary"
            onClick={startCompression}
            disabled={isProcessing || files.length === 0 || !outputDir}
            style={
              isSuccess
                ? { backgroundColor: "#10b981", pointerEvents: "none" }
                : {}
            }
          >
            {isProcessing ? (
              <>
                <Loader2 className="spin" size={20} /> Processing...
              </>
            ) : isSuccess ? (
              <>
                <Check size={20} /> Done!
              </>
            ) : (
              <>COMPRESS ({files.length})</>
            )}
          </button>
          {isSuccess && totalSaved > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                background: "#dcfce7",
                color: "#166534",
                borderRadius: 8,
                textAlign: "center",
                fontSize: "0.9rem",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <PartyPopper size={20} />
              You saved {formatBytes(totalSaved)}!
            </div>
          )}
          {isSuccess && (
            <button
              onClick={() => invoke("open_folder", { path: outputDir })}
              style={{
                background: "none",
                border: "none",
                color: "#64748b",
                textDecoration: "underline",
                cursor: "pointer",
                marginTop: 5,
                fontSize: "0.8rem",
              }}
            >
              Open Output Folder
            </button>
          )}
        </div>

        {isProcessing && files.length > 0 && (
          <div style={{ marginTop: 15, width: "100%" }}>
            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{
                  width: `${(processedCount / files.length) * 100}%`,
                }}
              />
            </div>
            <div className="progress-text">
              {processedCount} / {files.length}
            </div>
          </div>
        )}
      </aside>

      {/* MAIN */}
      <main className="main-content">
        {files.length === 0 ? (
          <div className="drop-zone" onClick={selectFiles} style={{ flex: 1 }}>
            <div className="drop-icon-circle">
              <FileUp size={48} color="#94a3b8" />
            </div>
            <h3>Drag & Drop images here</h3>
          </div>
        ) : (
          <>
            <div className="flex-between" style={{ marginBottom: 20 }}>
              <h2>My Images</h2>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn-secondary" onClick={selectFiles}>
                  <Plus size={18} /> Add
                </button>
                <button
                  className="btn-secondary"
                  onClick={clearFiles}
                  style={{
                    color: "#ef4444",
                    borderColor: "#fee2e2",
                    background: "#fef2f2",
                  }}
                >
                  <Trash2 size={18} /> Clear All
                </button>
              </div>
            </div>

            <div className="file-list">
              {files.map((file, i) => (
                <FileItemRow
                  key={file.path}
                  file={file}
                  status={statusMap[file.path] || "idle"}
                  onRemove={() => removeFile(i)}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;

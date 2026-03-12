"use client";

import React, { useState, useEffect, useRef } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faCircleNotch, 
  faExclamationTriangle,
  faDownload,
  faCheck,
  faPlay,
  faClapperboard,
  faMusic
} from '@fortawesome/free-solid-svg-icons';

export default function VideoConverter() {
  const [url, setUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<string | null>("loading");
  const [fileSize, setFileSize] = useState<number>(0);
  const [videoTitle, setVideoTitle] = useState<string | null>(null);
  const [error, setError] = useState<null | string>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [uploader, setUploader] = useState('');
  const [progression, setProgression] = useState(0);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [uriId, setUriId] = useState('');
  const [format, setFormat] = useState<string | null>(null);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "";
  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => { if (pollInterval.current) clearInterval(pollInterval.current); };
  }, []);

  const startPolling = (targetId: string) => {
    if (pollInterval.current) clearTimeout(pollInterval.current as NodeJS.Timeout);
    
    const poll = async () => {
      try {
        const res = await fetch(`${siteUrl}/api/status?id=${encodeURIComponent(targetId)}&audio_only=${isAudioOnly}`);
        
        if (!res.ok) {
          setError(`Server error: ${res.status}`);
          setIsProcessing(false);
          setStatus("loading");
          setThumbnailUrl("");
          setProgression(0);
          setFileSize(0);
          return; 
        }

        const data = await res.json();

        setStatus(data.status);
        setProgression(data.percent || 0);
        setFileSize(data.current_size || 0);
        setFormat(data.format || null);
        
        if (data.status === 'completed') {
          setIsProcessing(false);
          if (pollInterval.current) clearTimeout(pollInterval.current as NodeJS.Timeout);
          return;
        } else if (data.status === 'error' || data.status === 'failed') {
          setError("Processing failed on server.");
          setIsProcessing(false);
          setStatus("loading");
          setThumbnailUrl("");
          setProgression(0);
          setFileSize(0);
          if (pollInterval.current) clearTimeout(pollInterval.current as NodeJS.Timeout);
          return;
        }

        pollInterval.current = setTimeout(poll, 2000);

      } catch (err) {
        console.warn("Polling error (possible background/network issue):", err);
        setStatus("reconnecting"); 
        pollInterval.current = setTimeout(poll, 5000); 
      }
    };

    poll();
  };

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    e.preventDefault();
    setStatus("loading");
    setThumbnailUrl("");
    setProgression(0);
    setFileSize(0);
    setError(null);
    if (!url) return;
    setIsProcessing(true);
    setVideoTitle(null);

    try {
      const payload = { 
        url: url, 
        audio_only: isAudioOnly
      };

      const response = await fetch(`${siteUrl}/api/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || `Error: ${response.status}`);
      }

      setVideoTitle(data.title);
      setThumbnailUrl(data.thumbnail);
      setUriId(data.url_id);
      startPolling(data.url_id);
      setUploader(data.uploader);
      
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }

      setIsProcessing(false);
      setStatus("loading");
      setThumbnailUrl("");
      setProgression(0);
      setFileSize(0);
    }
  };


  const formatSize = (b: number) => {
    if (b === 0) return '0 B';
    if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
    return `${b.toFixed(2)} B`;
  };
  
  return (
    <div className="container-fluid min-vh-100 py-5 d-flex flex-column" style={{ backgroundColor: '#fffbfa' }}>
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6">
          
          <div className="text-center mb-5">
            <h1 className="display-5 fw-bold text-dark">YTDAlpha</h1>
            <span className="text-muted">Simple, clean, no pledging and no hazing.</span>
          </div>

          {/* Search Card */}
          <div className="card shadow border-0 p-3 p-md-4 mb-4" >
            <form onSubmit={handleSubmit}>
              <div className="input-group">
                <input
                  type="url"
                  className="form-control form-control-lg border-primary-subtle"
                  placeholder="Just paste a URL and let it cook..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={isProcessing}
                  required
                  autoFocus
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  style={{ height: '48px' }}
                />
                <button
                  className="btn btn-dark d-flex align-items-center justify-content-center"
                  type="submit"
                  disabled={isProcessing}
                  style={{ width: '48px', height: '48px', flexShrink: 0 }}
                >
                  {isProcessing ? (
                    <FontAwesomeIcon icon={faCircleNotch} spin style={{ width: '1rem' }} />
                  ) : (
                    <FontAwesomeIcon icon={faPlay} style={{ width: '1rem' }} />
                  )}
                </button>
              </div>
              {/* Format Selector */}
              <div className="mt-3 d-flex gap-3 justify-content-center">
                <div className="form-check form-check-inline">
                  <input
                    className="form-check-input"
                    type="radio"
                    name="formatOptions"
                    id="videoOption"
                    checked={!isAudioOnly}
                    onChange={() => setIsAudioOnly(false)}
                    disabled={isProcessing}
                  />
                  <label className="form-check-label text-secondary" htmlFor="videoOption">
                    <span style={{ display: 'inline-block', width: '1rem', height: '1rem', marginRight: '0.5rem' }}>
                      <FontAwesomeIcon icon={faClapperboard} />
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
                    onChange={() => setIsAudioOnly(true)}
                    disabled={isProcessing}
                  />
                  <label className="form-check-label text-secondary" htmlFor="audioOption">
                    <span style={{ display: 'inline-block', width: '1rem', height: '1rem', marginRight: '0.5rem' }}>
                      <FontAwesomeIcon icon={faMusic} />
                    </span>
                    Audio (MP3)
                  </label>
                </div>
              </div>
            </form>
          </div>

          {/* Error Message */}
          {error && (
            <div className="alert alert-danger alert-dismissible fade show d-flex align-items-center" role="alert">
              <FontAwesomeIcon icon={faExclamationTriangle} className="me-2" />
              <div><strong>Error:</strong> {error}</div>
              <button type="button" className="btn-close" onClick={() => setError(null)}></button>
            </div>
          )}

          {/* Status/Result Card */}
          {(isProcessing || status === 'completed') && (
            <div className="card shadow-sm border-0 animate-fade-in">
              <div className="card-body d-flex align-items-center p-3">
                {/* Thumbnail / Status Square */}
                <div 
                  className="rounded me-3 bg-dark d-flex align-items-center justify-content-center text-white" 
                  style={{ 
                    width: '80px', 
                    height: '80px', 
                    flexShrink: 0, 
                    position: 'relative', 
                    overflow: 'hidden' 
                  }}
                >
                  {thumbnailUrl && (
                    <img 
                      src={`https://wsrv.nl/?url=${encodeURIComponent(thumbnailUrl)}`}
                      alt="Thumbnail"
                      referrerPolicy="no-referrer"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover'
                      }}
                    />
                  )}

                  {/* Status Overlay */}
                  <div 
                    style={{
                      position: 'absolute',
                      top: 0, 
                      left: 0, 
                      right: 0, 
                      bottom: 0,
                      backgroundColor: status !== 'completed' ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'background-color 0.3s ease',
                      zIndex: 1
                    }}
                  >
                    {status !== 'completed' && (
                      <FontAwesomeIcon 
                        icon={faCircleNotch} 
                        spin 
                        size="2x" 
                        className="text-white" 
                        style={{ filter: 'drop-shadow(0px 0px 4px rgba(0,0,0,0.8))' }} 
                      />
                    )}
                    {status === 'completed' && (
                      <FontAwesomeIcon 
                        icon={faCheck} 
                        size="2x" 
                        className="text-white" 
                        style={{ 
                          filter: 'drop-shadow(0px 0px 6px rgba(0,0,0,0.9))',
                          opacity: 0.9 
                        }} 
                      />
                    )}
                  </div>
                </div>

                <div className="flex-grow-1 overflow-hidden">
                  <h6 className="text-truncate mb-1">{videoTitle || "Loading..."}</h6>
                  
                  {/* Status Indicator */}
                  <div className="small text-muted mb-2" style={{ minHeight: '24px' }}>
                    {status === 'loading' && (
                      <>
                        <span className="d-block mb-1">
                          Loading...
                        </span>
                        <span className="d-flex align-items-center">
                          <FontAwesomeIcon icon={faCircleNotch} spin className="me-2 text-primary" />
                          Initializing...
                        </span>
                      </>
                    )}
                    {status === 'extracting' && (
                      <>
                        <span className="d-block mb-1">
                          {uploader}
                        </span>
                        <span className="d-flex align-items-center">
                          <FontAwesomeIcon icon={faCircleNotch} spin className="me-2 text-primary" />
                          Extracting URL...
                        </span>
                      </>
                    )}
                    {status === 'processing' && (
                      <>
                        <span className="d-block mb-1">
                          {uploader}
                        </span>
                        <span className="d-flex align-items-center">
                          <FontAwesomeIcon icon={faCircleNotch} spin className="me-2 text-primary" />
                          Converting: {progression} %
                        </span>
                      </>
                    )}
                    {status === 'merging' && (
                      <>
                        <span className="d-block mb-1">
                          {uploader}
                        </span>
                        <span className="d-flex align-items-center text-warning">
                          <FontAwesomeIcon icon={faCircleNotch} spin className="me-2" />
                          Merging
                        </span>
                      </>
                    )}
                    {status === 'reconnecting' && (
                      <>
                        <span className="d-block mb-1">
                          {uploader}
                        </span>
                        <span className="d-flex align-items-center text-secondary">
                          <FontAwesomeIcon icon={faCircleNotch} spin className="me-2 text-muted" />
                          Reconnecting...
                        </span>
                      </>
                    )}
                    {status === 'completed' && (
                      <>
                        <span className="d-block mb-1">
                          {uploader}
                        </span>
                        <span className="text-success d-block">
                          <FontAwesomeIcon icon={faCheck} className="me-2" />
                          Ready ({formatSize(fileSize)}
                          {format && `, ${format}`})
                        </span>
                      </>
                    )}
                  </div>

                  {/* Buttons */}
                  <div className="d-flex gap-2">
                    <a 
                      href={`${siteUrl}/api/download?id=${uriId}&audio_only=${isAudioOnly}`}
                      className={`btn btn-sm ${status === 'completed' ? 'btn-outline-dark' : 'btn-outline-secondary disabled'}`}
                    >
                      <FontAwesomeIcon icon={faDownload} className="me-2" />
                      Download
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
      <footer className="py-4 mt-auto border-top">
        <div className="container text-center">
          <p className="text-muted mb-0 small">
            Because sometimes you just want the video without <b>writing a CLI thesis</b>.
          </p>
        </div>
      </footer>
    </div>
  );
}
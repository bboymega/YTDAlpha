import os
import re
import sys
import json
import time
import hashlib
import threading
import subprocess
import tempfile
import redis
import psutil
import random
import glob
import string
import secrets
from datetime import datetime
from flask import Flask, request, jsonify, send_file
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from urllib.parse import urlparse, parse_qs, urlunparse

load_dotenv()
redis_host = os.getenv('REDIS_HOST', 'localhost')
redis_port = int(os.getenv('REDIS_PORT', 6379))
redis_db = int(os.getenv('REDIS_DB', 0))
RETENTION = int(os.getenv('RETENTION_PERIOD', 21600))
META_CACHE_TTL = int(os.getenv('METADATA_CACHE_TTL', 86400))
r = redis.Redis(host=redis_host, port=redis_port, db=redis_db, decode_responses=True)

TEMP_DIR = os.path.join(tempfile.gettempdir(), "yt_task_cache")
os.makedirs(TEMP_DIR, exist_ok=True)

def create_app():
    app = Flask(__name__)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    return app

app = create_app()

def log_error(message, remote_addr="YTDAlpha"):
    timestamp = datetime.now().strftime('[%d/%b/%Y %H:%M:%S]')
    sys.stderr.write(f"\033[31m{timestamp} {remote_addr} \"ERROR: {message}\"\033[0m\n")

def log_info(message, remote_addr="YTDAlpha"):
    timestamp = datetime.now().strftime('[%d/%b/%Y %H:%M:%S]')
    print(f"{timestamp} {remote_addr} \"INFO: {message}\"", flush=True)

from urllib.parse import urlparse, parse_qs, urlunparse

def normalize_url(url):
    try:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        path = parsed.path

        if host.startswith("www."):
            host = host[4:]
        if host.startswith("m."):
            host = host[2:]

        if "youtube.com" in host or "youtu.be" in host:
            vid = None
            if "youtu.be" in host:
                vid = path.strip("/")
            else:
                qs = parse_qs(parsed.query)
                vid = qs.get("v", [None])[0]
            if vid:
                return f"yt:{vid}"

        if host in {"twitter.com", "x.com"}:
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 3 and parts[1] == "status":
                return f"tw:{parts[2]}"

        if "tiktok.com" in host:
            parts = [p for p in path.split("/") if p]
            if "video" in parts:
                return f"tt:{parts[-1]}"

        if "instagram.com" in host:
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2 and parts[0] in {"reel", "p", "tv"}:
                shortcode = parts[1]
                return f"ig:{shortcode}"

        if "vimeo.com" in host:
            parts = [p for p in path.split("/") if p]
            if parts and parts[0].isdigit():
                return f"vi:{parts[0]}"

        if "facebook.com" in host or "fb.watch" in host:
            if "fb.watch" in host:
                short = path.strip("/")
                if short:
                    return f"fb:{short}"

            qs = parse_qs(parsed.query)
            if "v" in qs:
                return f"fb:{qs['v'][0]}"

            parts = [p for p in path.split("/") if p]

            if "videos" in parts:
                idx = parts.index("videos")
                if len(parts) > idx + 1:
                    return f"fb:{parts[idx+1]}"

            if len(parts) >= 2 and parts[0] == "reel":
                return f"fb:{parts[1]}"

        clean = urlunparse((parsed.scheme, host, path.rstrip("/"), "", "", ""))
        return f"url:{clean}"

    except Exception:
        return f"url:{url}"

def get_cached_metadata(url, remote_addr):
    normalized_url = normalize_url(url)
    cache_key = f"meta:{normalized_url}"

    cached = r.get(cache_key)
    if cached:
        log_info(f"Using cached metadata for [{normalized_url}]", remote_addr)
        return json.loads(cached)

    log_info(f"Fetching metadata for URL: [{url}]", remote_addr)
    try:
        meta_cmd = [
            "yt-dlp",
            "--dump-json",
            "--no-playlist",
            "--flat-playlist",
            "--",
            url
        ]
        result = subprocess.run(meta_cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return None

        info = json.loads(result.stdout)
        meta_data = {
            "url_id": info.get("id"),
            "title": info.get("title", "video"),
            "thumbnail": info.get("thumbnail"),
            "uploader": info.get("uploader", "Unknown")
        }

        r.set(cache_key, json.dumps(meta_data), ex=META_CACHE_TTL)
        return meta_data

    except Exception as e:
        log_error(f"Metadata fetch failed: {e}", remote_addr)
        return None

def is_pid_alive(pid):
    if pid is None: return False
    try:
        return psutil.pid_exists(int(pid))
    except (ValueError, TypeError, psutil.NoSuchProcess):
        return False

def get_task(task_key):
    data = r.get(f"task:{task_key}")
    if not data: return None
    
    task = json.loads(data)
    set_task(task_key, task)
    if task.get('status') == 'processing':
        pid = task.get('pid')
        if pid and not is_pid_alive(pid):
            task.update({"status": "failed", "pid": None})
            set_task(task_key, task)

    return task

def set_task(task_key, task_data):
    r.set(f"task:{task_key}", json.dumps(task_data), ex=RETENTION)
    mode = "audio" if task_data.get("audio_only") else "video"
    normalized_url = normalize_url(task_data['url'])
    r.set(f"url_map:{mode}:{normalized_url}", task_key, ex=RETENTION*2)

def sanitize_name(name):
    return re.sub(r'[\\/*?:"<>|]', '_', name)[:150].strip()

def sanitize_output(data):
    return {k: v for k, v in data.items() if k not in ['file_path', 'pid', 'created_at', 'completed_at', 'url']}


def monitor_process(process, task_key, base_file_path, remote_addr, audio_only=False):
    progress_re = re.compile(r'\[download\]\s+(\d+\.\d+)%')
    new_file_re = re.compile(r'\[download\] Destination:')
    ffmpeg_re = re.compile(r'\[(VideoConvertor|Merger|ExtractAudio)\]')
    download_re = re.compile(r'(\[download\]|\[info\].*?Downloading)')
    
    last_reported_percent = 0.0
    download_phase = 0 

    try:
        for line in iter(process.stdout.readline, ''):
            if not line: break

            if download_re.search(line):
                task = get_task(task_key)
                task['status'] = 'processing'
                set_task(task_key, task)
            
            if new_file_re.search(line):
                download_phase += 1

            progress_match = progress_re.search(line)
            if progress_match:
                raw_percent = float(progress_match.group(1))
                display_percent = raw_percent if audio_only else (raw_percent * 0.9 if download_phase <= 1 else 90 + (raw_percent * 0.1))
                display_percent = min(display_percent, 99.9)

                if display_percent > last_reported_percent:
                    last_reported_percent = display_percent
                    task = get_task(task_key)
                    if task and task['status'] in ['extracting','processing', 'merging']:
                        task['percent'] = round(display_percent, 1)
                        set_task(task_key, task)

            elif ffmpeg_re.search(line):
                task = get_task(task_key)
                if task and task['status'] != 'completed':
                    log_info(f"Merging tracks for {task['id']}, title=[{task['title']}], uploader=[{task['uploader']}]", remote_addr)
                    task['status'] = 'merging'
                    task['percent'] = max(task['percent'], 99.9)
                    set_task(task_key, task)

        process.wait()
        task = get_task(task_key)

        if process.returncode == 0:
            final_files = [f for f in glob.glob(f"{base_file_path}*") if not f.endswith(('.part', '.ytdl', '.jpg', '.webp'))]
            if final_files:
                actual_path = final_files[0]
                task.update({
                    "status": "completed",
                    "percent": 100,
                    "file_path": actual_path,
                    "format": os.path.splitext(actual_path)[1][1:],
                    "completed_at": time.time(),
                    "pid": None
                })
                log_info(f"Task completed for {task['id']}, title=[{task['title']}], uploader=[{task['uploader']}], format={os.path.splitext(actual_path)[1][1:]}", remote_addr)
            else:
                log_info(f"Conversion failed for {task['id']}", remote_addr)
                task.update({"status": "failed", "pid": None})
        else:
            log_info(f"Conversion failed for {task['id']}", remote_addr)
            task.update({"status": "failed", "pid": None})

    except Exception as e:
        log_error(f"Monitor error: {str(e)}")
        task = get_task(task_key)
        if task: task.update({"status": "failed", "pid": None})
            
    finally:
        process.stdout.close()
        if task: set_task(task_key, task)


@app.route('/api/create', methods=['POST'])
def create_task():
    url = request.json.get('url')
    audio_only = request.json.get('audio_only', False)
    mode = "audio" if audio_only else "video"
    if not url: return jsonify({"status": "error", "message": "Missing URL"}), 400

    log_info(f"Conversion initiated for [{url}], audio_only={audio_only}", request.remote_addr)

    normalized_url = normalize_url(url)
    task_key_existing = r.get(f"url_map:{mode}:{normalized_url}")

    if task_key_existing:
        existing = get_task(task_key_existing)
        if existing:
            fpath = existing.get('file_path', '')
            if existing['status'] == 'completed' and os.path.exists(fpath):
                existing['current_size'] = os.path.getsize(fpath)
                log_info(f"Conversion already completed for [{url}], audio_only={audio_only}", request.remote_addr)
                return jsonify({"status": "completed", "url_id": existing['url_id'], "title": existing['title'], 'uploader': existing['uploader'], 'audio_only':audio_only, "thumbnail": existing['thumbnail']}), 200
            elif existing['status'] == 'processing':
                return jsonify({"status": "processing", "url_id": existing['url_id'], "title": existing['title'], 'uploader': existing['uploader'], 'audio_only':audio_only, "thumbnail": existing['thumbnail']}), 200
            elif existing['status'] == 'extracting':
                return jsonify({"status": "extracting", "url_id": existing['url_id'], "title": existing['title'], 'uploader': existing['uploader'], 'audio_only':audio_only, "thumbnail": existing['thumbnail']}), 200

    meta = get_cached_metadata(url, request.remote_addr)
    if not meta:
        return jsonify({"status": "error", "message": "Could not retrieve video metadata"}), 500

    url_id = meta['url_id']
    task_key = f"{url_id}_{mode}"
    
    existing = get_task(task_key)
    if existing and existing['status'] == 'completed' and os.path.exists(existing.get('file_path', '')):
        return jsonify(sanitize_output(existing)), 200

    salt = secrets.token_hex(4)
    init_file_path = os.path.join(TEMP_DIR, task_key)
    base_file_path = f"{init_file_path}_{salt}"
    
    dl_cmd = ['yt-dlp', '--newline', '--progress', '--no-playlist', '-o', f"{base_file_path}.%(ext)s", '--', url]
    if audio_only:
        dl_cmd.extend(['-x', '--audio-format', 'mp3', '--audio-quality', '0'])
    
    process = subprocess.Popen(dl_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    task_data = {
        "id": task_key,
        "url_id": url_id,
        "url": url,
        "title": sanitize_name(meta['title']),
        'uploader': sanitize_name(meta['uploader']),
        "status": "extracting",
        "percent": 0,
        "pid": process.pid,
        "thumbnail": meta['thumbnail'],
        "file_path": "",
        "audio_only": audio_only,
        "created_at": time.time()
    }
    
    set_task(task_key, task_data)
    threading.Thread(target=monitor_process, args=(process, task_key, base_file_path, request.remote_addr, audio_only), daemon=True).start()
    log_info(f"Task created for {url_id}, title=[{sanitize_name(meta['title'])}], uploader=[{sanitize_name(meta['uploader'])}], audio_only={audio_only}", request.remote_addr)
    return jsonify({"status": "created", "url_id":url_id, "title": sanitize_name(meta['title']), 'uploader': sanitize_name(meta['uploader']), 'audio_only':audio_only, "thumbnail": meta['thumbnail']}), 201

@app.route('/api/status', methods=['GET'])
def get_status():
    url_id = request.args.get('id')
    audio_only = request.args.get('audio_only', 'false').lower() == 'true'
    
    if not url_id: return jsonify({"status": "error", "message": "missing_id"}), 400

    task_key = f"{url_id}_{'audio' if audio_only else 'video'}"
    task = get_task(task_key)
    
    if not task: return jsonify({"status": "error", "message": "not_found"}), 404

    resp = task.copy()
    file_path = resp.get('file_path')
    if file_path and os.path.exists(file_path):
        resp['current_size'] = os.path.getsize(file_path)
    return jsonify(sanitize_output(resp))

@app.route('/api/download', methods=['GET'])
def download_file():
    url_id = request.args.get('id')
    audio_only = request.args.get('audio_only', 'false').lower() == 'true'

    task_key = f"{url_id}_{'audio' if audio_only else 'video'}"
    task = get_task(task_key)
    
    if not task or task['status'] != 'completed':
        return jsonify({"status": "error", "message": "Task not ready"}), 400
    
    fpath = task.get('file_path')
    if not fpath or not os.path.exists(fpath):
        return jsonify({"status": "error", "message": "File purged"}), 410

    task['completed_at'] = time.time()
    set_task(task_key, task)
    title = task.get('title', datetime.now().strftime("%Y%m%d") + "_" + ''.join(random.choices(string.ascii_lowercase + string.digits, k=6)))
    uploader = task.get('uploader', 'Unknown')
    log_info(
        f"File request for {url_id}, title=[{title}], uploader=[{uploader}], format={task.get('format','mp4')}, audio_only={audio_only}",
        request.remote_addr
    )

    return send_file(
        fpath,
        as_attachment=True,
        download_name=f"{title} - {uploader}.{task.get('format', 'mp4')}",
        mimetype='application/octet-stream'
    )


def run_cleanup():
    while True:
        try:
            now = time.time()
            tracked_files = set()
            active_task_ids = set()
            
            for key in r.scan_iter("task:*"):
                try:
                    task_data = r.get(key)
                    if not task_data: 
                        continue
                    
                    task = json.loads(task_data)
                    status = task.get("status")
                    pid = task.get("pid")
                    task_id = task.get("id")
                    fpath = task.get("file_path")

                    if task_id and status not in ["failed"]:
                        active_task_ids.add(task_id)

                    if status == "failed":
                        if fpath and os.path.exists(fpath):
                            try:
                                os.remove(fpath)
                                log_info(f"Failed Task Cleanup: Removed broken file {fpath}")
                                task['file_path'] = "" 
                                r.set(key, json.dumps(task), ex=RETENTION)
                            except: pass
                        
                        created_at = task.get("created_at", 0)
                        if now - created_at > RETENTION:
                            r.delete(key)
                        continue
                    
                    if fpath:
                        tracked_files.add(os.path.abspath(fpath))

                    if status in ["processing", "merging", "extracting"] and pid:
                        if not is_pid_alive(pid):
                            log_info(f"Purging dead process task: {key}")
                            
                            partial_pattern = os.path.join(TEMP_DIR, f"{task_id}*")
                            for partial_file in glob.glob(partial_pattern):
                                try:
                                    os.remove(partial_file)
                                    log_info(f"Cleaned up partial file: {partial_file}")
                                except Exception as e:
                                    log_error(f"Failed to delete {partial_file}: {e}")

                            task.update({
                                "status": "failed",
                                "pid": None
                            })
                            r.set(key, json.dumps(task), ex=RETENTION)
                            continue

                    completed_at = task.get("completed_at")
                    if completed_at and (now - completed_at > RETENTION):
                        if fpath and os.path.exists(fpath):
                            try:
                                os.remove(fpath)
                                log_info(f"Retention: Deleted expired file {fpath}")
                            except Exception as e:
                                log_error(f"Failed to delete expired file {fpath}: {e}")
                        r.delete(key)
                        if fpath in tracked_files:
                            tracked_files.remove(os.path.abspath(fpath))
                        
                except Exception as e:
                    log_error(f"Cleanup error on {key}: {e}")

            for fpath in glob.glob(os.path.join(TEMP_DIR, "*")):
                abs_fpath = os.path.abspath(fpath)
                filename = os.path.basename(abs_fpath)
                
                if abs_fpath in tracked_files:
                    continue

                if any(tid in filename for tid in active_task_ids if tid):
                    continue
                
                if os.path.isfile(abs_fpath):
                    file_age = now - os.path.getmtime(abs_fpath)
                    
                    if file_age > 600: 
                        try:
                            os.remove(abs_fpath)
                            log_info(f"Orphaned file: Deleted untracked file {abs_fpath}")
                        except Exception as e:
                            log_error(f"Failed to delete orphaned file {abs_fpath}: {e}")

        except Exception as e:
            log_error(f"Global cleanup loop error: {e}")
            
        time.sleep(300)

threading.Thread(target=run_cleanup, daemon=True).start()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
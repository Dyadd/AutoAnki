// OneNote to Anki Converter
// This application connects to OneNote via Microsoft Graph API,
// extracts content, and converts it into Anki-compatible flashcard decks

// Client-side code for index.html

document.addEventListener('DOMContentLoaded', () => {
    init();
});

// Application state
let currentNotebookId = '';
let currentSectionId = '';
let notebookPageData = {};
let isGenerating = false;
let isAuthenticated = false;

// Initialize the application
async function init() {
try {
    // Check authentication status
    await checkAuthStatus();
    
    // Setup event listeners
    setupEventListeners();
    
    // Load user's last selection if available
    loadLastSelection();
} catch (error) {
    console.error('Initialization error:', error);
    showNotification('Error initializing app. Please refresh the page.', true);
}
}

// Check if user is authenticated
async function checkAuthStatus() {
  console.log('Making request to /api/auth/status...');
  try {
    const response = await fetch('/api/auth/status');
    console.log('Auth status response received:', response.status);
    
    if (!response.ok) {
      console.error('Auth status check failed with status:', response.status);
      throw new Error(`Auth status check failed: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Auth status data:', data);

    isAuthenticated = data.authenticated;
    userName = data.userName;

    console.log(`Auth check result: authenticated=${isAuthenticated}, userName=${userName}`);
    updateAuthUI();
    return data;
  } catch (error) {
    console.error('Error checking auth status:', error);
    isAuthenticated = false;
    updateAuthUI();
    throw error;
  }
}

// Update UI based on authentication status
function updateAuthUI(authenticated, userName = '') {
const authStatus = document.getElementById('auth-status');
const userInfo = document.getElementById('user-info');
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');

// Update header display
const header = document.querySelector('.app-header');
if (header) {
    header.style.display = authenticated ? 'block' : 'none';
}

// Update login view display
const loginView = document.getElementById('login-view');
if (loginView) {
    loginView.style.display = authenticated ? 'none' : 'block';
}

// Update content view display
const contentView = document.getElementById('content-view');
if (contentView) {
    contentView.style.display = authenticated ? 'block' : 'none';
}

// Update navigation elements
if (authenticated) {
    if (authStatus) authStatus.textContent = 'Signed In';
    if (userInfo) userInfo.textContent = userName;
    if (loginButton) loginButton.style.display = 'none';
    if (logoutButton) logoutButton.style.display = 'block';
} else {
    if (authStatus) authStatus.textContent = 'Not Signed In';
    if (userInfo) userInfo.textContent = '';
    if (loginButton) loginButton.style.display = 'block';
    if (logoutButton) logoutButton.style.display = 'none';
}
}

// Load user data (notebooks)
async function loadUserData() {
showLoading('Loading notebooks...');

try {
    // Load notebooks
    await loadNotebooks();
    
    hideLoading();
} catch (error) {
    console.error('Error loading user data:', error);
    hideLoading();
    
    // If unauthorized, let auth status handler deal with it
    if (error.response && error.response.status === 401) {
    return;
    }
    
    showNotification('Error loading your notebooks. Please try again.', true);
}
}

// Setup event listeners
function setupEventListeners() {
// Authentication buttons
console.log('Setting up critical event listeners');
  
// Authentication buttons
const loginButton = document.getElementById('login-button');
if (loginButton) {
  console.log('Setting up login button');
  loginButton.addEventListener('click', () => {
    console.log('Login button clicked, redirecting to /auth/signin');
    window.location.href = '/auth/signin';
  });
} else {
  console.error('Login button not found');
}

const loginButtonMain = document.getElementById('login-button-main');
if (loginButtonMain) {
  console.log('Setting up main login button');
  loginButtonMain.addEventListener('click', () => {
    console.log('Main login button clicked, redirecting to /auth/signin');
    window.location.href = '/auth/signin';
  });
} else {
  console.error('Main login button not found');
}


const logoutButton = document.getElementById('logout-button');
if (logoutButton) {
    logoutButton.addEventListener('click', () => {
    window.location.href = '/auth/signout';
    });
}

// Notebook selection
const notebookSelect = document.getElementById('notebook-select');
if (notebookSelect) {
    notebookSelect.addEventListener('change', async function() {
    const notebookId = this.value;
    if (!notebookId) return;
    
    currentNotebookId = notebookId;
    currentSectionId = '';
    
    // Clear section select
    const sectionSelect = document.getElementById('section-select');
    if (sectionSelect) {
        sectionSelect.innerHTML = '<option value="">Select a section</option>';
    }
    
    // Disable action buttons
    document.getElementById('scan-button').disabled = true;
    document.getElementById('generate-button').disabled = true;
    
    // Save selection
    saveSelection();
    
    // Load sections for selected notebook
    await loadSections(notebookId);
    });
}

// Section selection
const sectionSelect = document.getElementById('section-select');
if (sectionSelect) {
    sectionSelect.addEventListener('change', function() {
    const sectionId = this.value;
    if (!sectionId) return;
    
    currentSectionId = sectionId;
    
    // Enable scan button
    document.getElementById('scan-button').disabled = false;
    
    // Disable generate button until scan is complete
    document.getElementById('generate-button').disabled = true;
    
    // Save selection
    saveSelection();
    });
}

// Scan button
const scanButton = document.getElementById('scan-button');
if (scanButton) {
    scanButton.addEventListener('click', async () => {
    if (!currentSectionId) {
        showNotification('Please select a section first', true);
        return;
    }
    
    await scanOneNoteSection(currentSectionId);
    });
}

// Generate button
const generateButton = document.getElementById('generate-button');
if (generateButton) {
    generateButton.addEventListener('click', async () => {
    if (!currentSectionId || !notebookPageData.pages || notebookPageData.pages.length === 0) {
        showNotification('Please scan a section first', true);
        return;
    }
    
    await generateAnkiDeck();
    });
}

// Navigation
document.querySelectorAll('.nav-item a').forEach(link => {
    link.addEventListener('click', (e) => {
    e.preventDefault();
    
    // Remove active class from all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Add active class to clicked nav item
    const navItem = e.currentTarget.parentElement;
    navItem.classList.add('active');
    
    // Show the corresponding view
    const viewId = e.currentTarget.getAttribute('data-view');
    showView(viewId);
    });
});
}

// Show a specific view
function showView(viewId) {
// Hide all views
document.querySelectorAll('.app-view').forEach(view => {
    view.style.display = 'none';
});

// Show the requested view
const viewToShow = document.getElementById(`${viewId}-view`);
if (viewToShow) {
    viewToShow.style.display = 'block';
}
}

// Load notebooks
async function loadNotebooks() {
try {
    const response = await fetch('/api/notebooks');
    
    if (!response.ok) {
    throw new Error(`Failed to fetch notebooks: ${response.status}`);
    }
    
    const notebooks = await response.json();
    
    // Populate notebook dropdown
    const notebookSelect = document.getElementById('notebook-select');
    if (notebookSelect) {
    notebookSelect.innerHTML = '<option value="">Select a notebook</option>';
    
    notebooks.forEach(notebook => {
        const option = document.createElement('option');
        option.value = notebook.id;
        option.textContent = notebook.displayName;
        notebookSelect.appendChild(option);
    });
    }
    
    return notebooks;
} catch (error) {
    console.error('Error loading notebooks:', error);
    throw error;
}
}

// Load sections for a notebook
async function loadSections(notebookId) {
showLoading('Loading sections...');

try {
    const response = await fetch(`/api/notebooks/${notebookId}/sections`);
    
    if (!response.ok) {
    throw new Error(`Failed to fetch sections: ${response.status}`);
    }
    
    const sections = await response.json();
    
    // Populate sections dropdown
    const sectionSelect = document.getElementById('section-select');
    if (sectionSelect) {
    sectionSelect.innerHTML = '<option value="">Select a section</option>';
    
    sections.forEach(section => {
        const option = document.createElement('option');
        option.value = section.id;
        option.textContent = section.displayName;
        sectionSelect.appendChild(option);
    });
    }
    
    hideLoading();
    return sections;
} catch (error) {
    console.error('Error loading sections:', error);
    hideLoading();
    throw error;
}
}

// Scan a OneNote section for pages
async function scanOneNoteSection(sectionId) {
if (!sectionId) return;

showLoading('Scanning OneNote section...');
updateProgress(5);

try {
    const response = await fetch(`/api/onenote/scan/${sectionId}`);
    
    if (!response.ok) {
    throw new Error(`Scan failed: ${response.status}`);
    }
    
    updateProgress(50);
    
    const data = await response.json();
    notebookPageData = data;
    
    // Update pages list
    updatePagesList(data.pages);
    
    // Enable generate button
    document.getElementById('generate-button').disabled = false;
    
    updateProgress(100);
    hideLoading();
    showNotification(`Found ${data.pages.length} pages in this section`);
} catch (error) {
    console.error('Error scanning section:', error);
    hideLoading();
    updateProgress(100);
    showNotification('Error scanning section. Please try again.', true);
}
}

// Update the pages list in the UI
function updatePagesList(pages) {
const pagesListElement = document.getElementById('pages-list');
if (!pagesListElement) return;

pagesListElement.innerHTML = '';

if (!pages || pages.length === 0) {
    pagesListElement.innerHTML = '<li class="list-group-item text-center text-muted">No pages found in this section</li>';
    return;
}

pages.forEach((page, index) => {
    const listItem = document.createElement('li');
    listItem.className = 'list-group-item';
    
    listItem.innerHTML = `
    <div class="form-check">
        <input class="form-check-input page-checkbox" type="checkbox" value="${page.id}" id="page-${index}" checked>
        <label class="form-check-label" for="page-${index}">
        ${page.title}
        </label>
    </div>
    `;
    
    pagesListElement.appendChild(listItem);
});

// Add select/deselect all controls
const controlsItem = document.createElement('li');
controlsItem.className = 'list-group-item d-flex justify-content-end';

controlsItem.innerHTML = `
    <button class="btn btn-sm btn-outline-primary me-2" id="select-all-pages">Select All</button>
    <button class="btn btn-sm btn-outline-secondary" id="deselect-all-pages">Deselect All</button>
`;

pagesListElement.insertBefore(controlsItem, pagesListElement.firstChild);

// Add event listeners for select/deselect buttons
document.getElementById('select-all-pages').addEventListener('click', () => {
    document.querySelectorAll('.page-checkbox').forEach(checkbox => {
    checkbox.checked = true;
    });
});

document.getElementById('deselect-all-pages').addEventListener('click', () => {
    document.querySelectorAll('.page-checkbox').forEach(checkbox => {
    checkbox.checked = false;
    });
});
}

// Generate Anki deck from selected pages
async function generateAnkiDeck() {
if (isGenerating) {
    showNotification('Generation already in progress', true);
    return;
}

// Get selected page IDs
const selectedPageIds = Array.from(document.querySelectorAll('.page-checkbox:checked'))
    .map(checkbox => checkbox.value);

if (selectedPageIds.length === 0) {
    showNotification('Please select at least one page', true);
    return;
}

isGenerating = true;
showLoading('Generating Anki deck...');
updateProgress(10);

try {
    // Get section name for deck title
    const sectionName = document.querySelector('#section-select option:checked').textContent || 'OneNote';
    
    const response = await fetch('/api/anki/generate', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        sectionId: currentSectionId,
        sectionName,
        pageIds: selectedPageIds
    })
    });
    
    if (!response.ok) {
    throw new Error(`Generation failed: ${response.status}`);
    }
    
    updateProgress(90);
    
    // Get the download URL from the response
    const result = await response.json();
    
    if (result.success && result.downloadUrl) {
    // Show success message with download button
    showDownloadNotification(result.downloadUrl, result.deckName);
    } else {
    showNotification('Failed to generate deck. Please try again.', true);
    }
    
    updateProgress(100);
} catch (error) {
    console.error('Error generating Anki deck:', error);
    showNotification('Error generating Anki deck. Please try again.', true);
} finally {
    hideLoading();
    isGenerating = false;
}
}

// Show download notification with button
function showDownloadNotification(downloadUrl, deckName) {
// Create or get notification container
let container = document.getElementById('download-notification');

if (!container) {
    container = document.createElement('div');
    container.id = 'download-notification';
    container.className = 'download-notification';
    document.body.appendChild(container);
}

// Set content
container.innerHTML = `
    <div class="download-notification-content">
    <div class="download-notification-header">
        <h5><i class="bi bi-check-circle-fill text-success me-2"></i>Deck Generated Successfully</h5>
        <button class="close-button">&times;</button>
    </div>
    <p>Your Anki deck "${deckName}" is ready to download.</p>
    <div class="download-notification-actions">
        <a href="${downloadUrl}" class="btn btn-primary" download="${deckName}.apkg">
        <i class="bi bi-download me-1"></i>Download Deck
        </a>
    </div>
    <p class="small text-muted mt-2">After downloading, open the file with Anki to import the deck.</p>
    </div>
`;

// Show the notification
container.style.display = 'flex';

// Add close handler
container.querySelector('.close-button').addEventListener('click', () => {
    container.style.display = 'none';
});
}

// Save last selection to localStorage
function saveSelection() {
try {
    localStorage.setItem('lastSelection', JSON.stringify({
    notebookId: currentNotebookId,
    sectionId: currentSectionId
    }));
} catch (error) {
    console.error('Error saving selection:', error);
}
}

// Load saved selection from localStorage
function loadLastSelection() {
try {
    const savedSelection = localStorage.getItem('lastSelection');
    if (!savedSelection) return;
    
    const { notebookId, sectionId } = JSON.parse(savedSelection);
    
    if (notebookId) {
    // Set notebook select value
    const notebookSelect = document.getElementById('notebook-select');
    if (notebookSelect) {
        notebookSelect.value = notebookId;
        currentNotebookId = notebookId;
        
        // Load sections for this notebook
        loadSections(notebookId).then(() => {
        if (sectionId) {
            // Set section select value
            const sectionSelect = document.getElementById('section-select');
            if (sectionSelect) {
            sectionSelect.value = sectionId;
            currentSectionId = sectionId;
            
            // Enable scan button
            document.getElementById('scan-button').disabled = false;
            }
        }
        });
    }
    }
} catch (error) {
    console.error('Error loading saved selection:', error);
}
}

// UI helper functions
function showLoading(message) {
const loadingElement = document.getElementById('loading-indicator');
if (loadingElement) {
    loadingElement.textContent = message || 'Loading...';
    loadingElement.style.display = 'flex';
}
}

function hideLoading() {
const loadingElement = document.getElementById('loading-indicator');
if (loadingElement) {
    loadingElement.style.display = 'none';
}
}

function updateProgress(percent) {
const progressBar = document.getElementById('progress-bar');
if (progressBar) {
    progressBar.style.width = `${percent}%`;
}
}

function showNotification(message, isError = false) {
const notification = document.getElementById('notification');
if (!notification) return;

notification.textContent = message;
notification.className = isError 
    ? 'notification notification-error'
    : 'notification notification-success';

notification.style.display = 'block';

// Auto-hide after 3 seconds
setTimeout(() => {
    notification.style.display = 'none';
}, 3000);
}
// OneNote to Anki Converter
// Enhanced client-side code for index.html

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
  console.log('Initializing application...');
  try {
    // Check authentication status first
    console.log('Checking authentication status...');
    const authData = await checkAuthStatus();
    console.log(`Authentication status: ${isAuthenticated ? 'Authenticated' : 'Not authenticated'}`);

    // We'll set this explicitly to ensure it's correctly updated
    isAuthenticated = authData.authenticated;
    userName = authData.userName || '';
    
    // Update UI explicitly
    updateAuthUI();

    // Setup event listeners
    console.log('Setting up event listeners...');
    setupEventListeners();

    // If authenticated, load content
    if (isAuthenticated) {
      console.log('User is authenticated, loading user data...');
      await loadUserData();
      
      // Try to load saved selection
      loadLastSelection();
    } else {
      console.log('User is not authenticated, displaying login screen');
    }

    // Set default value for max cards per page
    const maxCardsElement = document.getElementById('max-cards-per-page');
    if (maxCardsElement) {
      // Set to "No limit" option
      maxCardsElement.value = "0";
    }

    console.log('Initialization complete');
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
function updateAuthUI() {
  console.log(`Updating UI based on authentication status: ${isAuthenticated}`);
  
  // Select elements directly rather than using cached references
  const loginSection = document.getElementById('login-view');
  const contentSection = document.getElementById('content-view');
  const loginButton = document.getElementById('login-button');
  const logoutButton = document.getElementById('logout-button');
  const userInfoElement = document.getElementById('user-info');
  const authStatusElement = document.getElementById('auth-status');
  
  if (isAuthenticated) {
    console.log('User is authenticated, showing content view');
    
    // Show header if hidden
    const header = document.querySelector('.app-header');
    if (header) {
      header.style.display = 'block';
      console.log('Header display set to block');
    }
    
    if (loginSection) {
      loginSection.style.display = 'none';
      console.log('Login view hidden');
    } else {
      console.error('Login section element not found');
    }
    
    if (contentSection) {
      contentSection.style.display = 'block';
      console.log('Content view shown');
    } else {
      console.error('Content section element not found');
    }
    
    if (loginButton) loginButton.style.display = 'none';
    if (logoutButton) logoutButton.style.display = 'block';
    if (userInfoElement) userInfoElement.textContent = userName || 'User';
    if (authStatusElement) authStatusElement.textContent = 'Signed In';
  } else {
    console.log('User is not authenticated, showing login view');
    
    if (loginSection) {
      loginSection.style.display = 'block';
      console.log('Login view shown');
    } else {
      console.error('Login section element not found');
    }
    
    if (contentSection) {
      contentSection.style.display = 'none';
      console.log('Content view hidden');
    } else {
      console.error('Content section element not found');
    }
    
    if (loginButton) loginButton.style.display = 'block';
    if (logoutButton) logoutButton.style.display = 'none';
    if (userInfoElement) userInfoElement.textContent = '';
    if (authStatusElement) authStatusElement.textContent = 'Not Signed In';
  }
  
  // Force a browser reflow to update UI
  document.body.offsetHeight;
  
  console.log('UI update complete');
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
      
      // Clear pages list
      updatePagesList([]);
      
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
      
      // Clear pages list
      updatePagesList([]);
      
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
  
  // Card Type Preferences
  const cardTypeForm = document.getElementById('card-type-preferences');
  if (cardTypeForm) {
    // Save preferences when changed
    cardTypeForm.addEventListener('change', () => {
      saveCardPreferences();
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
  
  // Settings save button
  const saveSettingsButton = document.getElementById('save-settings');
  if (saveSettingsButton) {
    saveSettingsButton.addEventListener('click', () => {
      // Save all settings to localStorage
      const settings = {
        maxCardsPerPage: document.getElementById('max-cards-per-page').value,
        cardComplexity: document.getElementById('card-complexity').value,
        darkMode: document.getElementById('dark-mode').checked,
        enableAnimations: document.getElementById('enable-animations').checked,
        processImages: document.getElementById('process-images').checked,
        generateConceptMaps: document.getElementById('generate-concept-maps').checked,
        useOriginalText: document.getElementById('use-original-text').checked,
        includeMetadata: document.getElementById('include-metadata').checked
      };
      
      localStorage.setItem('appSettings', JSON.stringify(settings));
      showNotification('Settings saved successfully');
      
      // Apply dark mode if needed
      if (settings.darkMode) {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
    });
  }
  
  // Load saved settings on init
  loadSavedSettings();
}

// Load saved settings
function loadSavedSettings() {
  try {
    const savedSettingsString = localStorage.getItem('appSettings');
    if (!savedSettingsString) return;
    
    const settings = JSON.parse(savedSettingsString);
    
    // Apply settings to UI
    if (document.getElementById('max-cards-per-page')) {
      document.getElementById('max-cards-per-page').value = settings.maxCardsPerPage || "0";
    }
    
    if (document.getElementById('card-complexity')) {
      document.getElementById('card-complexity').value = settings.cardComplexity || "standard";
    }
    
    if (document.getElementById('dark-mode')) {
      document.getElementById('dark-mode').checked = settings.darkMode || false;
      // Apply dark mode
      if (settings.darkMode) {
        document.body.classList.add('dark-mode');
      }
    }
    
    if (document.getElementById('enable-animations')) {
      document.getElementById('enable-animations').checked = settings.enableAnimations !== false; // Default to true
    }
    
    if (document.getElementById('process-images')) {
      document.getElementById('process-images').checked = settings.processImages !== false; // Default to true
    }
    
    if (document.getElementById('generate-concept-maps')) {
      document.getElementById('generate-concept-maps').checked = settings.generateConceptMaps !== false; // Default to true
    }
    
    if (document.getElementById('use-original-text')) {
      document.getElementById('use-original-text').checked = settings.useOriginalText !== false; // Default to true
    }
    
    if (document.getElementById('include-metadata')) {
      document.getElementById('include-metadata').checked = settings.includeMetadata !== false; // Default to true
    }
  } catch (error) {
    console.error('Error loading saved settings:', error);
  }
}

// Save card type preferences
function saveCardPreferences() {
  const preferences = {
    enableCloze: document.getElementById('enable-cloze').checked,
    enableStandard: document.getElementById('enable-standard').checked,
    enableProcess: document.getElementById('enable-process').checked,
    enableConceptMap: document.getElementById('enable-concept-map').checked
  };
  
  localStorage.setItem('cardPreferences', JSON.stringify(preferences));
  return preferences;
}

// Load card type preferences
function loadCardPreferences() {
  try {
    const savedPrefs = localStorage.getItem('cardPreferences');
    if (!savedPrefs) {
      // Default preferences
      return {
        enableCloze: true,
        enableStandard: true,
        enableProcess: true,
        enableConceptMap: true
      };
    }
    
    const preferences = JSON.parse(savedPrefs);
    
    // Update UI
    if (document.getElementById('enable-cloze')) {
      document.getElementById('enable-cloze').checked = preferences.enableCloze;
    }
    if (document.getElementById('enable-standard')) {
      document.getElementById('enable-standard').checked = preferences.enableStandard;
    }
    if (document.getElementById('enable-process')) {
      document.getElementById('enable-process').checked = preferences.enableProcess;
    }
    if (document.getElementById('enable-concept-map')) {
      document.getElementById('enable-concept-map').checked = preferences.enableConceptMap;
    }
    
    return preferences;
  } catch (error) {
    console.error('Error loading card preferences:', error);
    return {
      enableCloze: true,
      enableStandard: true,
      enableProcess: true,
      enableConceptMap: true
    };
  }
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

  // Add select/deselect all controls
  const controlsItem = document.createElement('li');
  controlsItem.className = 'list-group-item d-flex justify-content-between align-items-center';
  
  controlsItem.innerHTML = `
    <span><strong>${pages.length}</strong> pages found</span>
    <div>
      <button class="btn btn-sm btn-outline-primary me-2" id="select-all-pages">Select All</button>
      <button class="btn btn-sm btn-outline-secondary" id="deselect-all-pages">Deselect All</button>
    </div>
  `;
  
  pagesListElement.appendChild(controlsItem);

  // Add each page with checkbox
  pages.forEach((page, index) => {
    const listItem = document.createElement('li');
    listItem.className = 'list-group-item';
    
    listItem.innerHTML = `
      <div class="form-check">
        <input class="form-check-input page-checkbox" type="checkbox" value="${page.id}" id="page-${index}" checked>
        <label class="form-check-label" for="page-${index}">
          ${page.title}
        </label>
        <small class="text-muted d-block">Last modified: ${new Date(page.lastModifiedDateTime).toLocaleString()}</small>
      </div>
    `;
    
    pagesListElement.appendChild(listItem);
  });

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

  // Get card preferences
  const cardPreferences = loadCardPreferences();
  if (!cardPreferences.enableCloze && !cardPreferences.enableStandard && !cardPreferences.enableProcess) {
    showNotification('Please enable at least one card type in Settings', true);
    return;
  }

  isGenerating = true;
  showLoading('Starting Anki deck generation...');
  updateProgress(0);
  
  // Create progress details element if it doesn't exist
  let progressDetails = document.getElementById('progress-details');
  if (!progressDetails) {
    progressDetails = document.createElement('div');
    progressDetails.id = 'progress-details';
    progressDetails.className = 'progress-details mt-2 text-center small';
    document.getElementById('loading-indicator').appendChild(progressDetails);
  }
  
  // Create progress percentage element if it doesn't exist
  let progressPercentage = document.querySelector('.progress-percentage');
  if (!progressPercentage) {
    progressPercentage = document.createElement('div');
    progressPercentage.className = 'progress-percentage';
    document.querySelector('.progress').appendChild(progressPercentage);
  }
  
  progressDetails.innerHTML = 'Initializing...';
  progressPercentage.textContent = '0%';
  
  try {
    // Get section name for deck title
    const sectionName = document.querySelector('#section-select option:checked').textContent || 'OneNote';
    
    // Get generation options from settings
    const maxCardsPerPage = parseInt(document.getElementById('max-cards-per-page')?.value || '0');
    const cardComplexity = document.getElementById('card-complexity')?.value || 'standard';
    const processImages = document.getElementById('process-images')?.checked ?? true;
    const generateConceptMaps = document.getElementById('generate-concept-maps')?.checked ?? true;
    const useOriginalText = document.getElementById('use-original-text')?.checked ?? true;
    const includeMetadata = document.getElementById('include-metadata')?.checked ?? true;
    
    // Build query parameters with all preferences
    const queryParams = new URLSearchParams({
      sectionId: currentSectionId,
      sectionName: encodeURIComponent(sectionName),
      pageIds: selectedPageIds.join(','),
      enableCloze: cardPreferences.enableCloze,
      enableStandard: cardPreferences.enableStandard,
      enableProcess: cardPreferences.enableProcess,
      enableConceptMap: cardPreferences.enableConceptMap,
      maxCardsPerPage,
      cardComplexity,
      processImages,
      generateConceptMaps,
      useOriginalText,
      includeMetadata
    });
    
    // Setup EventSource for server-sent events with new parameters
    const eventSource = new EventSource(`/api/anki/generate/stream?${queryParams}`);
    
    // Track cards as they're generated
    let cardCount = 0;
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.error) {
        showNotification(data.error, true);
        eventSource.close();
        isGenerating = false;
        hideLoading();
        return;
      }
      
      if (data.stage) {
        updateProgress(data.progress);
        progressDetails.innerHTML = data.message;
        progressPercentage.textContent = `${Math.floor(data.progress)}%`;
        
        // Track card count
        if (data.stage === 'page_complete' && data.cardCount) {
          cardCount += data.cardCount;
          progressDetails.innerHTML += `<br>Total cards so far: ${cardCount}`;
        }
      }
      
      if (data.complete) {
        eventSource.close();
        
        if (data.success && data.downloadUrl) {
          // Show success message with download button
          showDownloadNotification(data.downloadUrl, data.deckName, data.totalCards);
        } else {
          showNotification('Failed to generate deck. Please try again.', true);
        }
        
        hideLoading();
        isGenerating = false;
      }
    };
    
    eventSource.onerror = () => {
      eventSource.close();
      showNotification('Error generating Anki deck. Please try again.', true);
      hideLoading();
      isGenerating = false;
    };
    
  } catch (error) {
    console.error('Error generating Anki deck:', error);
    showNotification('Error generating Anki deck. Please try again.', true);
    hideLoading();
    isGenerating = false;
  }
}

// Show download notification with button
function showDownloadNotification(downloadUrl, deckName, totalCards) {
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
      <p>Your Anki deck "${deckName}" with ${totalCards} cards is ready to download.</p>
      <div class="download-notification-actions">
        <a href="${downloadUrl}" class="btn btn-primary" download="${deckName}.apkg">
          <i class="bi bi-download me-1"></i>Download Deck
        </a>
      </div>
      <p class="small text-muted mt-2">After downloading, open the file with Anki to import the deck.</p>
      <p class="small text-muted">The deck includes cloze deletions, standard cards, and key concept maps.</p>
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
    const messageElement = loadingElement.querySelector('.loading-message');
    if (messageElement) {
      messageElement.textContent = message || 'Loading...';
    }
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
    progressBar.setAttribute('aria-valuenow', percent);
  }
  
  const progressPercentage = document.querySelector('.progress-percentage');
  if (progressPercentage) {
    progressPercentage.textContent = `${Math.floor(percent)}%`;
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

  // Auto-hide after 4 seconds
  setTimeout(() => {
    notification.style.display = 'none';
  }, 4000);
}
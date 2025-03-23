// OneNote to Anki Converter - Server
const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { JSDOM } = require('jsdom');
const AnkiExport = require('anki-apkg-export').default;
const session = require('express-session');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Set up session management
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.set('trust proxy', 1); // trust first proxy

app.use(session({
  secret: process.env.SESSION_SECRET || 'onenote-flashcards-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
    httpOnly: true
  }
}));

// Serve static files
app.use(express.static('public'));

// Create uploads directory if it doesn't exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Microsoft Graph API authentication
const msalConfig = {
  auth: {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'common'}`
  }
};

const msalClient = new ConfidentialClientApplication(msalConfig);
const msGraphScopes = ['offline_access', 'Notes.Read', 'User.Read']; 

// Redirect URI for authentication
const REDIRECT_URI = process.env.REDIRECT_URI || `https://autoanki.fly.dev/auth/callback`;

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Authentication middleware
function ensureAuthenticated(req, res, next) {
  if (req.session.accessToken) {
    return next();
  }
  
  // Remember the original URL they were trying to access
  req.session.returnTo = req.originalUrl;
  res.status(401).json({ error: 'Authentication required', redirect: '/auth/signin' });
}

// Function to get a valid access token
async function getAccessToken(req) {
  // Check if token exists and is not expired
  if (!req.session.accessToken) {
    throw new Error('No access token available');
  }

  // If token is expired, refresh it
  if (req.session.tokenExpires && new Date() > new Date(req.session.tokenExpires)) {
    if (!req.session.refreshToken) {
      throw new Error('No refresh token available');
    }
    
    try {
      const refreshTokenRequest = {
        refreshToken: req.session.refreshToken,
        scopes: msGraphScopes
      };
      
      const response = await msalClient.acquireTokenByRefreshToken(refreshTokenRequest);
      
      // Update session with new tokens
      req.session.accessToken = response.accessToken;
      req.session.refreshToken = response.refreshToken || req.session.refreshToken;
      req.session.tokenExpires = new Date(Date.now() + (response.expiresIn * 1000));
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw new Error('Failed to refresh access token');
    }
  }
  
  return req.session.accessToken;
}

// Microsoft Graph API functions
async function callGraphAPI(req, url, options = {}) {
  try {
    const accessToken = await getAccessToken(req);
    
    const response = await axios({
      url: url.startsWith('https://') ? url : `https://graph.microsoft.com/v1.0${url}`,
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...options.headers
      },
      data: options.data,
      params: options.params,
      responseType: options.responseType || 'json'
    });
    return response.data;
  } catch (error) {
    console.error(`Error calling Graph API (${url}):`, error.response?.data || error.message);
    throw error;
  }
}

// Get all results with pagination
async function getAllGraphResults(req, initialUrl, options = {}) {
  let results = [];
  let nextLink = initialUrl;
  
  while (nextLink) {
    const response = await callGraphAPI(req, nextLink, options);
    
    if (response.value && Array.isArray(response.value)) {
      results = results.concat(response.value);
    }
    
    nextLink = response['@odata.nextLink'];
  }
  
  return results;
}

// OneNote API functions
async function getOneNoteNotebooks(req) {
  return await getAllGraphResults(req, '/me/onenote/notebooks');
}

async function getOneNoteSections(req, notebookId) {
  return await getAllGraphResults(req, `/me/onenote/notebooks/${notebookId}/sections`);
}

async function getOneNotePages(req, sectionId) {
  const url = `/me/onenote/sections/${sectionId}/pages`;
  const params = {
    '$select': 'id,title,createdDateTime,lastModifiedDateTime',
    '$orderby': 'lastModifiedDateTime desc',
    '$top': 100
  };
  
  return await getAllGraphResults(req, url, { params });
}

async function getPageContent(req, pageId) {
  return await callGraphAPI(req, `/me/onenote/pages/${pageId}/content`, {
    responseType: 'text'
  });
}

// Extract text from OneNote HTML content
function extractTextFromOneNoteHtml(html) {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Remove non-content elements
    const elementsToRemove = ['style', 'meta', 'script', 'img'];
    elementsToRemove.forEach(tag => {
      const elements = document.querySelectorAll(tag);
      elements.forEach(el => el.remove());
    });
    
    // Extract content from meaningful elements
    const contentElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, ul, ol, li, table, div.content');
    
    let extractedText = '';
    contentElements.forEach(el => {
      const content = el.textContent.trim();
      if (content) {
        if (el.tagName.startsWith('H')) {
          extractedText += `### ${content}\n\n`;
        } else if (el.tagName === 'LI') {
          extractedText += `- ${content}\n`;
        } else {
          extractedText += `${content}\n\n`;
        }
      }
    });
    
    return extractedText.trim();
  } catch (error) {
    console.error('Error extracting text from HTML:', error);
    // Fallback to simple HTML stripping if JSDOM fails
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// Extract flashcards from content using Gemini AI
async function extractFlashcardsWithAI(content, pageTitle) {
  try {
    const textContent = typeof content === 'string' && content.includes('<html') 
      ? extractTextFromOneNoteHtml(content)
      : content;
    
    // Calculate approximate tokens (for truncation if needed)
    const estimatedTokens = textContent.split(/\s+/).length;
    const maxContentTokens = 6000;
    
    // Truncate if too long
    let processableContent = textContent;
    if (estimatedTokens > maxContentTokens) {
      console.log(`Content too large (est. ${estimatedTokens} tokens), truncating...`);
      processableContent = textContent
        .split(/\s+/)
        .slice(0, maxContentTokens)
        .join(' ');
    }
    
    // Prompt for Gemini
    const prompt = `
Create high-quality flashcards from the following notes on "${pageTitle}".

Each flashcard should have:
1. A clear, focused question that tests a specific concept
2. A concise but complete answer (1-3 sentences)
3. Tags that categorize the content (optional)

Format your response as JSON:
[
  {
    "question": "What is the definition of X?",
    "answer": "X is defined as...",
    "tags": ["key-concept", "definition"]
  }
]

Here are the notes:
${processableContent}
`;

    // Initialize Gemini model and generate content
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON from response
    let flashcards;
    try {
      // Try to extract JSON if it's wrapped in code blocks
      const jsonMatch = responseText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || 
                        responseText.match(/(\[[\s\S]*?\])/);
                        
      if (jsonMatch && jsonMatch[1]) {
        flashcards = JSON.parse(jsonMatch[1]);
      } else {
        flashcards = JSON.parse(responseText);
      }
      
      // Validate and clean up flashcards
      if (!Array.isArray(flashcards)) {
        throw new Error('Invalid flashcards format');
      }
      
      return flashcards.map(card => ({
        question: card.question || '',
        answer: card.answer || '',
        tags: Array.isArray(card.tags) ? card.tags : []
      })).filter(card => card.question && card.answer);
      
    } catch (e) {
      console.error('Error parsing AI response:', e);
      return []; // Return empty array on parse error
    }
  } catch (error) {
    console.error('Error extracting flashcards with AI:', error);
    return [];
  }
}

// Generate an Anki APKG file from flashcards
async function generateAnkiPackage(deckName, flashcards) {
  try {
    // Create a new Anki package
    const apkg = new AnkiExport(deckName);
    
    // Add each flashcard
    for (const card of flashcards) {
      // Format tags for Anki (space-separated string)
      const tags = card.tags && Array.isArray(card.tags) 
        ? card.tags.join(' ')
        : '';
      
      // Add card to deck - format HTML for better display in Anki
      apkg.addCard(
        `<div class="question">${card.question}</div>`,
        `<div class="answer">${card.answer}</div>`,
        { tags }
      );
    }
    
    // Generate the package
    const zip = await apkg.save();
    
    // Generate a unique filename
    const filename = `${deckName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}.apkg`;
    const filePath = path.join(UPLOADS_DIR, filename);
    
    // Write the file
    fs.writeFileSync(filePath, zip);
    
    return {
      filePath,
      filename,
      deckName
    };
  } catch (error) {
    console.error('Error generating Anki package:', error);
    throw error;
  }
}

// ------ ROUTES ------

// Main application page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auth status check
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.accessToken,
    userName: req.session.userName || null
  });
});

// Authentication Routes
app.get('/auth/signin', async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.authState = state;
    
    const authCodeUrlParameters = {
      scopes: msGraphScopes,
      redirectUri: REDIRECT_URI,
      state: state
    };
    
    const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParameters);
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error during auth redirect:', error);
    res.status(500).send('Error initiating authentication');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    console.log('Auth callback received', {
      code: req.query.code ? 'present' : 'missing',
      state: req.query.state,
      session: req.session ? 'present' : 'missing',
      sessionId: req.sessionID
    });

    // Exchange code for token
    const tokenRequest = {
      code: req.query.code,
      scopes: msGraphScopes,
      redirectUri: REDIRECT_URI
    };
    
    const response = await msalClient.acquireTokenByCode(tokenRequest);
    console.log('Token acquired successfully');
    
    // Save tokens in session
    req.session.accessToken = response.accessToken;
    req.session.refreshToken = response.refreshToken;
    req.session.tokenExpires = new Date(Date.now() + (response.expiresIn * 1000));
    
    // Get user information and store in session
    const userInfo = await callGraphAPI(req, '/me');
    req.session.userId = userInfo.id;
    req.session.userEmail = userInfo.mail || userInfo.userPrincipalName;
    req.session.userName = userInfo.displayName;
    
    console.log('Session updated with user info', {
      userId: userInfo.id,
      email: req.session.userEmail,
      sessionId: req.sessionID
    });

    // Save session explicitly
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session:', err);
      }
      
      // Redirect to original destination or home page
      const returnUrl = req.session.returnTo || '/';
      delete req.session.returnTo;
      
      console.log('Redirecting to:', returnUrl);
      res.redirect(returnUrl);
    });
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

app.get('/auth/signout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// OneNote API Routes
app.get('/api/notebooks', ensureAuthenticated, async (req, res) => {
  try {
    const notebooks = await getOneNoteNotebooks(req);
    res.json(notebooks);
  } catch (error) {
    console.error('Error fetching notebooks:', error);
    res.status(500).json({ error: 'Failed to fetch notebooks' });
  }
});

app.get('/api/notebooks/:notebookId/sections', ensureAuthenticated, async (req, res) => {
  try {
    const sections = await getOneNoteSections(req, req.params.notebookId);
    res.json(sections);
  } catch (error) {
    console.error('Error fetching sections:', error);
    res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

// Scan a OneNote section for pages
app.get('/api/onenote/scan/:sectionId', ensureAuthenticated, async (req, res) => {
  try {
    const pages = await getOneNotePages(req, req.params.sectionId);
    
    res.json({
      sectionId: req.params.sectionId,
      pages: pages.map(page => ({
        id: page.id,
        title: page.title,
        createdDateTime: page.createdDateTime,
        lastModifiedDateTime: page.lastModifiedDateTime
      }))
    });
  } catch (error) {
    console.error('Error scanning section:', error);
    res.status(500).json({ error: 'Failed to scan section' });
  }
});

// Generate Anki deck from selected OneNote pages
app.post('/api/anki/generate', ensureAuthenticated, async (req, res) => {
  try {
    const { sectionId, sectionName, pageIds } = req.body;
    
    if (!sectionId || !pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    }
    
    // Track progress
    let currentPage = 0;
    const totalPages = pageIds.length;
    let allFlashcards = [];
    
    // Process each page
    for (const pageId of pageIds) {
      currentPage++;
      
      try {
        // Get page content and title
        const pages = await getOneNotePages(req, sectionId);
        const pageInfo = pages.find(p => p.id === pageId);
        
        if (!pageInfo) {
          console.warn(`Page ${pageId} not found, skipping...`);
          continue;
        }
        
        const pageTitle = pageInfo.title;
        const content = await getPageContent(req, pageId);
        
        // Extract flashcards using AI
        const flashcards = await extractFlashcardsWithAI(content, pageTitle);
        
        // Add page title as a tag to all cards
        const formattedPageTag = pageTitle
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        
        // Add page info to each flashcard
        const pageFlashcards = flashcards.map(card => ({
          ...card,
          tags: [...(card.tags || []), formattedPageTag],
          sourcePageTitle: pageTitle,
          sourcePageId: pageId
        }));
        
        allFlashcards = [...allFlashcards, ...pageFlashcards];
      } catch (error) {
        console.error(`Error processing page ${pageId}:`, error);
        // Continue with other pages
      }
    }
    
    // Generate a readable deck name
    const deckName = `${sectionName.replace(/[^a-zA-Z0-9 ]/g, '')}_${new Date().toISOString().split('T')[0]}`;
    
    // Generate Anki package
    const { filePath, filename } = await generateAnkiPackage(deckName, allFlashcards);
    
    // Return download URL
    const downloadUrl = `/download/${filename}`;
    
    res.json({
      success: true,
      totalPages,
      totalCards: allFlashcards.length,
      downloadUrl,
      deckName
    });
  } catch (error) {
    console.error('Error generating Anki deck:', error);
    res.status(500).json({ error: 'Failed to generate Anki deck' });
  }
});

// Download route for Anki files
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  
  res.download(filePath);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
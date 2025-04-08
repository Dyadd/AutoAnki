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

// Create images directory for storing extracted images
const IMAGES_DIR = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

// Download images from OneNote and save them locally
async function downloadImage(req, imageUrl, imageName) {
  try {
    const response = await callGraphAPI(req, imageUrl, {
      responseType: 'arraybuffer'
    });
    
    const imagePath = path.join(IMAGES_DIR, imageName);
    fs.writeFileSync(imagePath, Buffer.from(response));
    
    return `/images/${imageName}`;
  } catch (error) {
    console.error('Error downloading image:', error);
    return null;
  }
}

// Extract content from OneNote HTML, including text and images
async function extractContentFromOneNoteHtml(req, html, pageId) {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Extract text content
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
    
    // Extract images
    const images = document.querySelectorAll('img');
    const extractedImages = [];
    
    for (const img of images) {
      const src = img.getAttribute('src');
      if (src && (src.startsWith('http') || src.startsWith('/'))) {
        const imageId = uuidv4();
        const imageExt = src.split('.').pop().split('?')[0] || 'png';
        const imageName = `${pageId}_${imageId}.${imageExt}`;
        
        // Extract alt text if available for better context
        const altText = img.getAttribute('alt') || '';
        
        // Get surrounding text for context
        let contextText = '';
        let parent = img.parentElement;
        if (parent) {
          // Look for caption or figure text
          const caption = parent.querySelector('figcaption, .caption');
          if (caption) {
            contextText = caption.textContent.trim();
          } else {
            // Get text before and after the image
            const parentText = parent.textContent.trim();
            if (parentText) {
              contextText = parentText;
            }
          }
        }
        
        try {
          const localPath = await downloadImage(req, src, imageName);
          if (localPath) {
            extractedImages.push({
              path: localPath,
              altText: altText,
              context: contextText
            });
            
            // Add a reference to this image in the extracted text
            extractedText += `\n![Image: ${altText || 'OneNote image'}](${localPath})\n${contextText ? `*${contextText}*\n` : ''}\n`;
          }
        } catch (imgError) {
          console.error('Error processing image:', imgError);
        }
      }
    }
    
    // Handle ink drawings (SVG content)
    const svgElements = document.querySelectorAll('svg');
    for (const svg of svgElements) {
      const svgContent = svg.outerHTML;
      const svgId = uuidv4();
      const svgName = `${pageId}_${svgId}.svg`;
      const svgPath = path.join(IMAGES_DIR, svgName);
      
      fs.writeFileSync(svgPath, svgContent);
      
      extractedImages.push({
        path: `/images/${svgName}`,
        altText: 'Ink Drawing',
        context: 'Hand-drawn content from OneNote'
      });
      
      extractedText += `\n![Ink Drawing](/images/${svgName})\n*Hand-drawn content from OneNote*\n\n`;
    }
    
    return {
      text: extractedText.trim(),
      images: extractedImages
    };
  } catch (error) {
    console.error('Error extracting content from HTML:', error);
    // Fallback to simple HTML stripping if JSDOM fails
    return {
      text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      images: []
    };
  }
}

// Generate a concept map from notes using AI
async function generateConceptMap(content, pageTitle) {
  try {
    // Calculate approximate tokens for truncation if needed
    const estimatedTokens = content.split(/\s+/).length;
    const maxContentTokens = 6000;
    
    // Truncate if too long
    let processableContent = content;
    if (estimatedTokens > maxContentTokens) {
      console.log(`Content too large (est. ${estimatedTokens} tokens), truncating for concept map...`);
      processableContent = content
        .split(/\s+/)
        .slice(0, maxContentTokens)
        .join(' ');
    }
    
    // Prompt for concept map generation
    const prompt = `
Create a concept map from the following notes on "${pageTitle}".

Analyze the content and identify:
1. Key concepts and terms
2. Hierarchical relationships (parent-child)
3. Sequential relationships (steps in a process)
4. Causal relationships (cause and effect)
5. Comparative relationships (similarities and differences)

Format your response as JSON:
{
  "concepts": [
    {
      "id": "concept1",
      "name": "Main Concept Name",
      "description": "Brief description of the concept"
    },
    ...
  ],
  "relationships": [
    {
      "source": "concept1",
      "target": "concept2",
      "type": "hierarchical|sequential|causal|comparative",
      "description": "Description of the relationship"
    },
    ...
  ]
}

Here are the notes:
${processableContent}
`;

    // Initialize Gemini model and generate content
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-exp-03-25" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON from response
    try {
      // Try to extract JSON if it's wrapped in code blocks
      const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || 
                      responseText.match(/(\{[\s\S]*?\})/);
                      
      if (jsonMatch && jsonMatch[1]) {
        return JSON.parse(jsonMatch[1]);
      } else {
        return JSON.parse(responseText);
      }
    } catch (e) {
      console.error('Error parsing concept map response:', e);
      // Return empty concept map on error
      return { concepts: [], relationships: [] };
    }
  } catch (error) {
    console.error('Error generating concept map:', error);
    return { concepts: [], relationships: [] };
  }
}

// Generate a text representation of the concept map for inclusion in card notes
function generateConceptMapText(conceptMap, focusConcept = null) {
  try {
    if (!conceptMap || !conceptMap.concepts || !conceptMap.relationships) {
      return '';
    }
    
    let result = '## Concept Map\n\n';
    
    // If we have a focus concept, only include directly related concepts
    if (focusConcept) {
      // Find the concept
      const concept = conceptMap.concepts.find(c => 
        c.name.toLowerCase() === focusConcept.toLowerCase() || 
        c.id === focusConcept
      );
      
      if (concept) {
        result += `### ${concept.name}\n`;
        if (concept.description) {
          result += `${concept.description}\n\n`;
        }
        
        // Find direct relationships
        const relations = conceptMap.relationships.filter(r => 
          r.source === concept.id || r.target === concept.id
        );
        
        if (relations.length > 0) {
          result += 'Related Concepts:\n';
          
          relations.forEach(rel => {
            const isSource = rel.source === concept.id;
            const otherId = isSource ? rel.target : rel.source;
            const otherConcept = conceptMap.concepts.find(c => c.id === otherId);
            
            if (otherConcept) {
              const relationshipType = rel.type || 'related to';
              const direction = isSource ? '→' : '←';
              
              result += `- ${concept.name} ${direction} ${otherConcept.name} (${relationshipType})\n`;
              if (rel.description) {
                result += `  ${rel.description}\n`;
              }
            }
          });
        }
      }
    } else {
      // Include all major concepts and relationships
      result += '### Key Concepts\n';
      
      conceptMap.concepts.forEach(concept => {
        result += `- **${concept.name}**: ${concept.description || ''}\n`;
      });
      
      result += '\n### Relationships\n';
      
      conceptMap.relationships.forEach(rel => {
        const sourceConcept = conceptMap.concepts.find(c => c.id === rel.source);
        const targetConcept = conceptMap.concepts.find(c => c.id === rel.target);
        
        if (sourceConcept && targetConcept) {
          result += `- **${sourceConcept.name}** → **${targetConcept.name}** (${rel.type || 'related'})\n`;
          if (rel.description) {
            result += `  ${rel.description}\n`;
          }
        }
      });
    }
    
    return result;
  } catch (error) {
    console.error('Error generating concept map text:', error);
    return '';
  }
}

// Process images with multimodal AI to extract relevant information
async function processImagesWithAI(images, pageTitle) {
  if (!images || images.length === 0) {
    return [];
  }
  
  try {
    const processedImages = [];
    
    for (const image of images) {
      // Skip processing if no image path
      if (!image.path) continue;
      
      // For each image, we'll create an analysis using multimodal AI
      const imagePath = path.join(__dirname, 'public', image.path);
      
      // Check if file exists
      if (!fs.existsSync(imagePath)) {
        console.error(`Image file not found: ${imagePath}`);
        continue;
      }
      
      try {
        // Read image file as base64 for API
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        
        // Create prompt for multimodal model
        const prompt = `
Analyze this image from the OneNote page titled "${pageTitle}".

Describe:
1. What type of content is shown (diagram, chart, screenshot, hand-drawn illustration, etc.)
2. The key information presented in the image
3. Any labels, annotations, or text visible in the image
4. How this image relates to the topic "${pageTitle}"

Also identify:
- Key parts that could be used for flashcard creation
- Potential questions that could be asked about this image
- How this image might connect to the broader topic

Context information provided with the image: "${image.context || ''}"
Alt text for the image: "${image.altText || ''}"
`;

        // Call multimodal model
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-exp-03-25" });
        
        // Prepare the image data for the model
        const imageData = {
          inlineData: {
            data: base64Image,
            mimeType: path.extname(imagePath) === '.svg' ? 'image/svg+xml' : 'image/png'
          }
        };
        
        // Generate content with both text and image
        const result = await model.generateContent([prompt, imageData]);
        const analysis = result.response.text();
        
        // Add processed information to the image
        processedImages.push({
          ...image,
          analysis,
          // Extract potential questions from the analysis
          potentialQuestions: extractQuestionsFromAnalysis(analysis)
        });
      } catch (imgError) {
        console.error(`Error processing image with AI: ${image.path}`, imgError);
        processedImages.push({
          ...image,
          analysis: "Error processing image with AI.",
          potentialQuestions: []
        });
      }
    }
    
    return processedImages;
  } catch (error) {
    console.error('Error in processImagesWithAI:', error);
    return [];
  }
}

// Helper function to extract potential questions from image analysis
function extractQuestionsFromAnalysis(analysis) {
  try {
    // Look for questions in the analysis
    const questionMatches = analysis.match(/Question[s]?:[\s\S]*?((?:\d+\.|-)[\s\S]*?)(?:\n\n|\n(?=\d+\.)|$)/gi) || [];
    
    const questions = [];
    
    questionMatches.forEach(match => {
      // Extract individual questions
      const individualQuestions = match.match(/(?:\d+\.|-)([^\n]+)/g) || [];
      
      individualQuestions.forEach(q => {
        // Clean up the question text
        const questionText = q.replace(/^\d+\.|-\s*/, '').trim();
        if (questionText) {
          questions.push(questionText);
        }
      });
    });
    
    return questions;
  } catch (error) {
    console.error('Error extracting questions from analysis:', error);
    return [];
  }
}

// Extract flashcards from content using Gemini AI
async function extractFlashcardsWithAI(content, pageTitle, conceptMap, processedImages = []) {
  try {
    // Calculate approximate tokens for truncation if needed
    const estimatedTokens = content.split(/\s+/).length;
    const maxContentTokens = 6000;
    
    // Truncate if too long
    let processableContent = content;
    if (estimatedTokens > maxContentTokens) {
      console.log(`Content too large (est. ${estimatedTokens} tokens), truncating...`);
      processableContent = content
        .split(/\s+/)
        .slice(0, maxContentTokens)
        .join(' ');
    }
    
    // Prepare concept map summary
    let conceptMapSummary = '';
    if (conceptMap && conceptMap.concepts && conceptMap.concepts.length > 0) {
      conceptMapSummary = `
Key concepts identified:
${conceptMap.concepts.map(c => `- ${c.name}: ${c.description || ''}`).join('\n')}

Key relationships:
${conceptMap.relationships.map(r => {
  const source = conceptMap.concepts.find(c => c.id === r.source)?.name || r.source;
  const target = conceptMap.concepts.find(c => c.id === r.target)?.name || r.target;
  return `- ${source} → ${target} (${r.type || 'related to'}): ${r.description || ''}`;
}).join('\n')}
`;
    }
    
    // Prepare image information
    let imagesSummary = '';
    if (processedImages && processedImages.length > 0) {
      imagesSummary = `
The notes include ${processedImages.length} images or diagrams:
${processedImages.map((img, index) => 
  `Image ${index + 1}: ${img.altText || 'Unnamed image'} - ${img.context || 'No context provided'}`
).join('\n')}
`;
    }
    
    // Prompt for Gemini to create flashcards
    const prompt = `
Create high-quality flashcards from the following notes on "${pageTitle}".

${conceptMapSummary}

${imagesSummary}

IMPORTANT INSTRUCTIONS:
1. PRIORITIZE cloze deletion cards that use the student's EXACT phrasing
2. Create process/sequence cards that show the steps and mechanisms
3. Include connection cards that test relationships between concepts
4. For all cards, include explanations of key terms in the notes section
5. Be comprehensive - cover ALL the information in the notes, especially:
   - Sequences (what happens before/after)
   - Locations (where processes occur)
   - Timing (when things happen)
   - Cause and effect relationships
   - Connections between different concepts

For each card:
- Use the student's original language and structure whenever possible
- Include explanations of key terms in the notes section
- Reference relevant images where appropriate

Format your response as JSON:
[
  {
    "type": "cloze",
    "text": "Original text with {{c1::term to be hidden}}",
    "notes": "Explanations of key terms and additional context",
    "relatedConcepts": ["concept1", "concept2"],
    "relatedImages": ["image1.png"],
    "tags": ["key-concept", "process"]
  },
  {
    "type": "standard",
    "question": "What is X?",
    "answer": "X is defined as...",
    "notes": "Explanations and context",
    "relatedConcepts": ["concept1", "concept2"],
    "relatedImages": ["image1.png"],
    "tags": ["key-concept", "definition"]
  }
]

Here are the notes:
${processableContent}
`;

    // Initialize Gemini model and generate content
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-exp-03-25" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON from response
    try {
      // Try to extract JSON if it's wrapped in code blocks
      const jsonMatch = responseText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || 
                      responseText.match(/(\[[\s\S]*?\])/);
                      
      if (jsonMatch && jsonMatch[1]) {
        const flashcards = JSON.parse(jsonMatch[1]);
        
        // Enhance flashcards with concept map information
        return enhanceFlashcardsWithConceptMap(flashcards, conceptMap, processedImages);
      } else {
        const flashcards = JSON.parse(responseText);
        return enhanceFlashcardsWithConceptMap(flashcards, conceptMap, processedImages);
      }
    } catch (e) {
      console.error('Error parsing AI response:', e);
      return []; // Return empty array on parse error
    }
  } catch (error) {
    console.error('Error extracting flashcards with AI:', error);
    return [];
  }
}

// Enhance flashcards with concept map information
function enhanceFlashcardsWithConceptMap(flashcards, conceptMap, processedImages) {
  if (!Array.isArray(flashcards)) return [];
  
  return flashcards.map(card => {
    try {
      // Get the main concept this card is about
      let mainConcept = null;
      
      if (card.relatedConcepts && card.relatedConcepts.length > 0) {
        mainConcept = card.relatedConcepts[0];
      } else if (card.type === 'standard' && card.question) {
        // Try to identify main concept from question
        const questionWords = card.question.toLowerCase().split(/\s+/);
        
        for (const concept of conceptMap.concepts || []) {
          if (questionWords.includes(concept.name.toLowerCase())) {
            mainConcept = concept.id;
            break;
          }
        }
      } else if (card.type === 'cloze' && card.text) {
        // Try to identify main concept from cloze text
        const clozeText = card.text.toLowerCase();
        
        for (const concept of conceptMap.concepts || []) {
          if (clozeText.includes(concept.name.toLowerCase())) {
            mainConcept = concept.id;
            break;
          }
        }
      }
      
      // Generate concept map text for this specific card
      const conceptMapText = mainConcept ? 
        generateConceptMapText(conceptMap, mainConcept) : 
        '';
      
      // Find related images based on concept
      const relatedImages = [];
      
      if (card.relatedImages && Array.isArray(card.relatedImages)) {
        // Images directly specified in the card
        relatedImages.push(...card.relatedImages);
      } else if (mainConcept && processedImages.length > 0) {
        // Try to find related images based on concept
        for (const image of processedImages) {
          if (image.analysis && image.analysis.toLowerCase().includes(mainConcept.toLowerCase())) {
            relatedImages.push(image.path);
          }
        }
      }
      
      // Format image references for inclusion in notes
      let imageReferences = '';
      if (relatedImages.length > 0) {
        imageReferences = '\n\n## Related Images\n';
        relatedImages.forEach(imagePath => {
          const imageInfo = processedImages.find(img => img.path === imagePath);
          if (imageInfo) {
            imageReferences += `\n![${imageInfo.altText || 'Image'}](${imagePath})\n`;
            if (imageInfo.context) {
              imageReferences += `*${imageInfo.context}*\n`;
            }
          } else {
            imageReferences += `\n![Image](${imagePath})\n`;
          }
        });
      }
      
      // Enhance notes with concept map and image references
      let enhancedNotes = card.notes || '';
      
      if (conceptMapText) {
        enhancedNotes += '\n\n' + conceptMapText;
      }
      
      if (imageReferences) {
        enhancedNotes += '\n\n' + imageReferences;
      }
      
      return {
        ...card,
        notes: enhancedNotes.trim(),
        relatedImages: relatedImages
      };
    } catch (error) {
      console.error('Error enhancing flashcard with concept map:', error);
      return card;
    }
  });
}

// Generate an Anki APKG file from flashcards
async function generateAnkiPackage(deckName, flashcards) {
  try {
    // Create a new Anki package
    const apkg = new AnkiExport(deckName);
    
    // Add card models for different card types
    // Cloze model is built-in to Anki
    
    // Add each flashcard
    for (const card of flashcards) {
      // Format tags for Anki (space-separated string)
      const tags = card.tags && Array.isArray(card.tags) 
        ? card.tags.join(' ')
        : '';
      
      if (card.type === 'cloze') {
        // Handle cloze deletion cards
        // Anki uses {{c1::text}} format for clozes
        let clozeText = card.text;
        
        // Convert any other cloze format to Anki's format if needed
        // e.g., [cloze:text] to {{c1::text}}
        if (!clozeText.includes('{{c')) {
          clozeText = clozeText.replace(/\[cloze:(.*?)\]/g, '{{c1::$1}}');
        }
        
        // Add cloze card to deck
        apkg.addCard(
          clozeText,
          '', // Answer field is not used for cloze cards
          { tags, modelName: 'Cloze', fields: { Text: clozeText, Extra: card.notes || '' } }
        );
      } else {
        // Add standard question/answer cards
        apkg.addCard(
          `<div class="question">${card.question}</div>`,
          `<div class="answer">${card.answer}</div>`,
          { tags, notes: card.notes || '' }
        );
      }
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
        const htmlContent = await getPageContent(req, pageId);
        
        // Extract content (text and images)
        const extractedContent = await extractContentFromOneNoteHtml(req, htmlContent, pageId);
        
        // Process images with AI (if any)
        const processedImages = await processImagesWithAI(extractedContent.images, pageTitle);
        
        // Generate concept map
        const conceptMap = await generateConceptMap(extractedContent.text, pageTitle);
        
        // Extract flashcards using AI
        const flashcards = await extractFlashcardsWithAI(
          extractedContent.text, 
          pageTitle, 
          conceptMap,
          processedImages
        );
        
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
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

const ankiBridge = require('./anki_bridge');

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
    
    // Start with a simple header
    let result = '<div class="concept-map">\n<h3>Concept Map</h3>\n';
    
    // If we have a focus concept, only include directly related concepts
    if (focusConcept) {
      // Find the concept
      const concept = conceptMap.concepts.find(c => 
        c.name?.toLowerCase() === focusConcept.toLowerCase() || 
        c.id === focusConcept
      );
      
      if (concept) {
        result += `<p><strong>${concept.name}</strong>`;
        if (concept.description) {
          result += `: ${concept.description}`;
        }
        result += '</p>\n';
        
        // Find direct relationships
        const relations = conceptMap.relationships.filter(r => 
          r.source === concept.id || r.target === concept.id
        );
        
        if (relations.length > 0) {
          result += '<p><strong>Related Concepts:</strong></p>\n<ul>\n';
          
          relations.forEach(rel => {
            const isSource = rel.source === concept.id;
            const otherId = isSource ? rel.target : rel.source;
            const otherConcept = conceptMap.concepts.find(c => c.id === otherId);
            
            if (otherConcept) {
              const relationshipType = rel.type || 'related to';
              const direction = isSource ? '→' : '←';
              
              result += `<li>${concept.name} ${direction} ${otherConcept.name} (${relationshipType})`;
              if (rel.description) {
                result += `<br><em>${rel.description}</em>`;
              }
              result += '</li>\n';
            }
          });
          
          result += '</ul>\n';
        }
      }
    } else {
      // Include all major concepts and relationships in a simple format
      result += '<p><strong>Key Concepts:</strong></p>\n<ul>\n';
      
      conceptMap.concepts.forEach(concept => {
        result += `<li><strong>${concept.name}</strong>`;
        if (concept.description) {
          result += `: ${concept.description}`;
        }
        result += '</li>\n';
      });
      
      result += '</ul>\n';
      
      if (conceptMap.relationships.length > 0) {
        result += '<p><strong>Relationships:</strong></p>\n<ul>\n';
        
        conceptMap.relationships.forEach(rel => {
          const sourceConcept = conceptMap.concepts.find(c => c.id === rel.source);
          const targetConcept = conceptMap.concepts.find(c => c.id === rel.target);
          
          if (sourceConcept && targetConcept) {
            result += `<li>${sourceConcept.name} → ${targetConcept.name} (${rel.type || 'related'})`;
            if (rel.description) {
              result += `<br><em>${rel.description}</em>`;
            }
            result += '</li>\n';
          }
        });
        
        result += '</ul>\n';
      }
    }
    
    result += '</div>\n';
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
async function extractFlashcardsWithAI(content, pageTitle, conceptMap, processedImages = [], preferences = {}) {
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
    
    // Adjust card type instructions based on preferences
    let cardTypeInstructions = '';
    const enabledCardTypes = [];
    
    if (preferences.enableCloze) {
      enabledCardTypes.push("cloze deletion cards");
      // Make cloze cards the highest priority
      cardTypeInstructions += `1. PRIORITIZE cloze deletion cards using the format {{c1::term to be hidden}}, ensuring you're using the same language and structure as the original notes.\n   Example: "The process of {{c1::photosynthesis}} converts light energy into chemical energy."\n`;
    }
    
    if (preferences.enableProcess) {
      enabledCardTypes.push("process/sequence cards");
      cardTypeInstructions += `${enabledCardTypes.length}. Create process/sequence cards that show the steps and mechanisms\n`;
    }
    
    if (preferences.enableStandard) {
      enabledCardTypes.push("standard Q&A cards");
      cardTypeInstructions += `${enabledCardTypes.length}. Create standard question and answer cards for key concepts and definitions\n`;
    }
    
    // If no card types are explicitly enabled, default to all
    if (enabledCardTypes.length === 0) {
      cardTypeInstructions = `
1. PRIORITIZE cloze deletion cards using the format {{c1::term to be hidden}}, ensuring you're using the same language and structure as the original notes.
   Example: "The process of {{c1::photosynthesis}} converts light energy into chemical energy."
2. Create process/sequence cards that show the steps and mechanisms
3. Create standard question and answer cards for key concepts and definitions
`;
    }
    
    // Add additional instructions based on preferences
    let additionalInstructions = '';
    if (preferences.enableConceptMap) {
      additionalInstructions += "4. Include concept maps to show key relationships between concepts.\n";
    }
    
    if (preferences.useOriginalText) {
      additionalInstructions += "- Use the student's original language and structure whenever possible\n";
    }
    
    if (preferences.includeMetadata) {
      additionalInstructions += "- Include explanations of key terms in the notes section\n";
    }
    
    // Set card complexity based on preferences
    let complexityInstructions = '';
    switch(preferences.cardComplexity) {
      case 'basic':
        complexityInstructions = "Create simpler cards with straightforward questions and answers. Focus on core concepts only.";
        break;
      case 'advanced':
        complexityInstructions = "Create more detailed and advanced cards that include nuanced information and connections between concepts.";
        break;
      default: // standard
        complexityInstructions = "Create balanced cards with appropriate detail for comprehensive understanding.";
        break;
    }
    
    // Prompt for Gemini to create flashcards
    const prompt = `
Create high-quality flashcards from the following notes on "${pageTitle}".

${conceptMapSummary}

${imagesSummary}

IMPORTANT INSTRUCTIONS:
${cardTypeInstructions}
${additionalInstructions}
5. Be comprehensive - cover ALL the information in the notes, especially:
   - Sequences (what happens before/after)
   - Locations (where processes occur)
   - Timing (when things happen)
   - Cause and effect relationships
   - Connections between different concepts

${complexityInstructions}

For each card:
- Include explanations of key terms in the notes section to provide context
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
        
        // Enhance flashcards with concept map information if enabled
        const enhancedCards = preferences.enableConceptMap ? 
          enhanceFlashcardsWithConceptMap(flashcards, conceptMap, processedImages) :
          flashcards;
          
        return processFlashcardFormats(enhancedCards);
      } else {
        const flashcards = JSON.parse(responseText);
        const enhancedCards = preferences.enableConceptMap ? 
          enhanceFlashcardsWithConceptMap(flashcards, conceptMap, processedImages) :
          flashcards;
          
        return processFlashcardFormats(enhancedCards);
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
          if (concept.name && questionWords.includes(concept.name.toLowerCase())) {
            mainConcept = concept.id;
            break;
          }
        }
      } else if (card.type === 'cloze' && card.text) {
        // Try to identify main concept from cloze text
        const clozeText = card.text.toLowerCase();
        
        for (const concept of conceptMap.concepts || []) {
          if (concept.name && clozeText.includes(concept.name.toLowerCase())) {
            mainConcept = concept.id;
            break;
          }
        }
      }
      
      // Generate concept map section with simple formatting
      let conceptMapText = '';
      if (mainConcept) {
        // Find the concept
        const concept = conceptMap.concepts.find(c => c.id === mainConcept);
        
        if (concept) {
          conceptMapText = '<div class="concept-map">\n';
          conceptMapText += `<h3>Concept Map: ${concept.name}</h3>\n`;
          
          if (concept.description) {
            conceptMapText += `<p>${concept.description}</p>\n`;
          }
          
          // Find direct relationships
          const relations = conceptMap.relationships.filter(r => 
            r.source === concept.id || r.target === concept.id
          );
          
          if (relations.length > 0) {
            conceptMapText += '<p><strong>Related Concepts:</strong></p>\n<ul>\n';
            
            relations.forEach(rel => {
              const isSource = rel.source === concept.id;
              const otherId = isSource ? rel.target : rel.source;
              const otherConcept = conceptMap.concepts.find(c => c.id === otherId);
              
              if (otherConcept) {
                const relationshipType = rel.type || 'related to';
                const direction = isSource ? '→' : '←';
                
                conceptMapText += `<li><span class="relationship"><strong>${concept.name}</strong> ${direction} <strong>${otherConcept.name}</strong></span> (${relationshipType})`;
                if (rel.description) {
                  conceptMapText += `<br><em>${rel.description}</em>`;
                }
                conceptMapText += '</li>\n';
              }
            });
            
            conceptMapText += '</ul>\n';
          }
          
          conceptMapText += '</div>\n';
        }
      } else if (conceptMap.concepts && conceptMap.concepts.length > 0) {
        // No specific concept focus, include a brief summary
        conceptMapText = '<div class="concept-map">\n';
        conceptMapText += '<h3>Key Concepts</h3>\n<ul>\n';
        
        // Just include a few major concepts (max 5)
        conceptMap.concepts.slice(0, 5).forEach(concept => {
          conceptMapText += `<li><strong>${concept.name}</strong>`;
          if (concept.description) {
            conceptMapText += `: ${concept.description}`;
          }
          conceptMapText += '</li>\n';
        });
        
        conceptMapText += '</ul>\n</div>\n';
      }
      
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
      
      // Format image references in a simple way
      let imageReferences = '';
      if (relatedImages.length > 0) {
        imageReferences = '<h3>Related Images</h3>\n';
        relatedImages.forEach(imagePath => {
          const imageInfo = processedImages.find(img => img.path === imagePath);
          const filename = path.basename(imagePath);
          
          imageReferences += `<img src="${filename}" alt="${imageInfo?.altText || 'Image'}">\n`;
          if (imageInfo && imageInfo.context) {
            imageReferences += `<em>${imageInfo.context}</em>\n`;
          }
        });
      }
      
      // Combine notes, concept map, and images
      let enhancedNotes = '';
      
      // Add original notes if they exist
      if (card.notes && card.notes.trim()) {
        enhancedNotes += card.notes.trim();
      }
      
      // Add concept map if available
      if (conceptMapText && conceptMapText.trim()) {
        enhancedNotes += (enhancedNotes ? '<hr>' : '') + conceptMapText;
      }
      
      // Add image references if available
      if (imageReferences) {
        enhancedNotes += (enhancedNotes ? '<hr>' : '') + imageReferences;
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

// Process flashcard formats (handle cloze syntax, etc)
function processFlashcardFormats(flashcards) {
  if (!Array.isArray(flashcards)) return [];
  
  return flashcards.map(card => {
    // Ensure type exists
    if (!card.type) {
      card.type = card.question && card.answer ? 'standard' : 'cloze';
    }
    
    // Only format cloze text if it's already a cloze type
    if (card.type === 'cloze' && card.text) {
      // Convert [cloze:text] format to Anki format if needed
      if (card.text.includes('[cloze:')) {
        card.text = card.text.replace(/\[cloze:(.*?)\]/g, '{{c1::$1}}');
      }
      
      // Make sure we have at least one cloze deletion
      if (!card.text.includes('{{c')) {
        // Try to identify terms to create a cloze
        const terms = extractImportantTerms(card.text);
        if (terms.length > 0) {
          // Use the first term as a cloze deletion
          card.text = card.text.replace(new RegExp(`\\b${terms[0]}\\b`, 'i'), `{{c1::${terms[0]}}}`);
        }
      }
    }
    
    return card;
  });
}

// Helper function to extract important terms for cloze cards
function extractImportantTerms(text) {
  if (!text) return [];
  
  // Look for capitalized terms or terms in quotes as likely important concepts
  const capitalizedTerms = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
  const quotedTerms = text.match(/"([^"]+)"|'([^']+)'/g) || [];
  
  // Clean up quoted terms by removing quotes
  const cleanQuotedTerms = quotedTerms.map(term => term.replace(/['"]/g, ''));
  
  // Combine and remove duplicates
  const allTerms = [...new Set([...capitalizedTerms, ...cleanQuotedTerms])];
  
  return allTerms;
}

// Converts markdown-style notes to HTML for better Anki formatting
function formatNotesForAnki(notes) {
  if (!notes) return '';
  
  // Add improved styling for better readability in Anki
  return `<div class="anki-notes">
${notes}
<style>
  .anki-notes { 
    font-family: Arial, sans-serif; 
    line-height: 1.5; 
    color: #333;
    max-width: 700px;
    margin: 0 auto;
  }
  .anki-notes h2, .anki-notes h3 { 
    color: #2196F3; 
    margin-top: 15px; 
  }
  .anki-notes h2 { 
    border-bottom: 1px solid #e0e0e0; 
    padding-bottom: 5px; 
    font-size: 1.4em;
  }
  .anki-notes h3 {
    font-size: 1.2em;
    margin-bottom: 8px;
  }
  .anki-notes em { color: #666; }
  .anki-notes strong { 
    color: #333;
    font-weight: bold;
  }
  .anki-notes img { 
    max-width: 100%; 
    margin: 10px 0; 
    border: 1px solid #ddd; 
    border-radius: 4px; 
    padding: 5px; 
    display: block;
  }
  .anki-notes ul { padding-left: 20px; }
  .anki-notes .concept-map { 
    background-color: #f9f9f9; 
    padding: 10px; 
    border-radius: 5px; 
    margin: 10px 0; 
    border-left: 3px solid #2196F3; 
  }
  .anki-notes .relationship {
    color: #4CAF50;
    font-weight: bold;
  }
  .anki-notes hr { 
    border: 0; 
    height: 1px; 
    background: #ddd; 
    margin: 15px 0; 
  }
</style>
</div>`;
}

// Generate an Anki APKG file from flashcards
async function generateAnkiPackage(deckName, flashcards) {
  try {
    // Create a new Anki package
    const apkg = new AnkiExport(deckName);
    
    // Add media files first (for all the images referenced in flashcards)
    const processedMediaFiles = new Set();
    
    // Process all flashcards to extract and add media
    for (const card of flashcards) {
      // Handle images in notes - markdown syntax
      if (card.notes) {
        const imageMatches = card.notes.match(/!\[.*?\]\((.*?)\)/g) || [];
        
        for (const imgMatch of imageMatches) {
          const imgPath = imgMatch.match(/!\[.*?\]\((.*?)\)/)[1];
          if (imgPath && !processedMediaFiles.has(imgPath)) {
            // Extract filename from path
            const filename = path.basename(imgPath);
            
            // Get the full path to the image
            const relativeImgPath = imgPath.replace(/^\/+/, '');
            const fullImagePath = path.join(__dirname, 'public', relativeImgPath);
            
            if (fs.existsSync(fullImagePath)) {
              // Add the media file to the package
              const imageData = fs.readFileSync(fullImagePath);
              apkg.addMedia(filename, imageData);
              processedMediaFiles.add(imgPath);
              
              // Replace path in notes to use just the filename (Anki's media folder format)
              card.notes = card.notes.replace(new RegExp(imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), filename);
            }
          }
        }
      }
      
      // Handle images in notes - HTML syntax
      if (card.notes) {
        const imgSrcMatches = card.notes.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g) || [];
        
        for (const imgTag of imgSrcMatches) {
          const srcMatch = imgTag.match(/src=["']([^"']+)["']/);
          if (srcMatch && srcMatch[1]) {
            const imgPath = srcMatch[1];
            
            if (!imgPath.startsWith('http') && !processedMediaFiles.has(imgPath)) {
              // Extract filename from path
              const filename = path.basename(imgPath);
              
              // Handle both relative and absolute paths
              const fullImagePath = imgPath.startsWith('/') 
                ? path.join(__dirname, 'public', imgPath)
                : path.join(__dirname, 'public', imgPath);
              
              if (fs.existsSync(fullImagePath)) {
                // Add the media file to the package
                const imageData = fs.readFileSync(fullImagePath);
                apkg.addMedia(filename, imageData);
                processedMediaFiles.add(imgPath);
                
                // Replace path in notes to use just the filename
                card.notes = card.notes.replace(new RegExp(imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), filename);
              }
            }
          }
        }
      }
      
      // Handle related images separately if they exist
      if (card.relatedImages && Array.isArray(card.relatedImages)) {
        for (const imgPath of card.relatedImages) {
          if (imgPath && !processedMediaFiles.has(imgPath)) {
            const filename = path.basename(imgPath);
            const fullImagePath = path.join(__dirname, 'public', imgPath);
            
            if (fs.existsSync(fullImagePath)) {
              const imageData = fs.readFileSync(fullImagePath);
              apkg.addMedia(filename, imageData);
              processedMediaFiles.add(imgPath);
            }
          }
        }
      }
    }
    
    // Add each flashcard
    for (const card of flashcards) {
      // Format tags for Anki (space-separated string)
      const tags = card.tags && Array.isArray(card.tags) 
        ? card.tags.join(' ')
        : '';
      
      // Check for cloze syntax in the card content
      const hasClozeMarkers = (card.text && card.text.includes('{{c')) || 
                             (card.answer && card.answer.includes('{{c'));

      // Force card to be cloze type if it has cloze markers
      if (hasClozeMarkers) {
        card.type = 'cloze';
      }
      
      // Format notes for Anki with minimal styling
      const formattedNotes = formatNotesForAnki(card.notes || '');
      
      if (card.type === 'cloze') {
        // Handle cloze deletion cards
        let clozeText = card.text || '';
        
        // Convert alternate cloze format if needed
        if (clozeText.includes('[cloze:')) {
          clozeText = clozeText.replace(/\[cloze:(.*?)\]/g, '{{c1::$1}}');
        }
        
        // Add cloze card with proper model name and fields
        apkg.addCard(
          '', // Front field isn't used directly for cloze cards
          '', // Back field isn't used directly for cloze cards
          { 
            tags, 
            modelName: 'Cloze', 
            fields: { 
              Text: clozeText, 
              Extra: formattedNotes
            } 
          }
        );
      } else {
        // Add standard question/answer cards with notes field
        const frontText = card.question || '';
        const backText = card.answer || '';
        
        apkg.addCard(
          frontText,
          backText,
          { 
            tags, 
            modelName: 'Basic', 
            fields: {
              Front: frontText,
              Back: backText + (formattedNotes ? `<hr>${formattedNotes}` : '')
            }
          }
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
    const { sectionId, sectionName, pageIds, preferences } = req.body;
    
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
        
        // Process images with AI (if setting enabled)
        const processImages = preferences?.processImages !== false;
        const processedImages = processImages ? 
          await processImagesWithAI(extractedContent.images, pageTitle) :
          extractedContent.images.map(img => ({ ...img, analysis: '', potentialQuestions: [] }));
        
        // Generate concept map (if setting enabled)
        const generateConceptMaps = preferences?.generateConceptMaps !== false;
        const conceptMap = generateConceptMaps ? 
          await generateConceptMap(extractedContent.text, pageTitle) :
          { concepts: [], relationships: [] };
        
        // Extract flashcards using AI with preferences
        const flashcards = await extractFlashcardsWithAI(
          extractedContent.text, 
          pageTitle, 
          conceptMap,
          processedImages,
          preferences || {}
        );
        
        // Apply card limit if set
        let pageFlashcards = flashcards;
        if (preferences?.maxCardsPerPage > 0 && flashcards.length > preferences.maxCardsPerPage) {
          pageFlashcards = flashcards.slice(0, preferences.maxCardsPerPage);
        }
        
        // Add page title as a tag to all cards
        const formattedPageTag = pageTitle
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        
        // Add page info to each flashcard
        const taggedFlashcards = pageFlashcards.map(card => ({
          ...card,
          tags: [...(card.tags || []), formattedPageTag],
          sourcePageTitle: pageTitle,
          sourcePageId: pageId
        }));
        
        allFlashcards = [...allFlashcards, ...taggedFlashcards];
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

// Replace your existing '/api/anki/generate/stream' endpoint with this one
app.get('/api/anki/generate/stream', ensureAuthenticated, async (req, res) => {
  try {
    const { sectionId, sectionName } = req.query;
    const pageIds = req.query.pageIds.split(',');
    
    // Get card generation preferences from query parameters
    const preferences = {
      enableCloze: req.query.enableCloze === 'true',
      enableStandard: req.query.enableStandard === 'true',
      enableProcess: req.query.enableProcess === 'true',
      enableConceptMap: req.query.enableConceptMap === 'true',
      maxCardsPerPage: parseInt(req.query.maxCardsPerPage || '0'),
      cardComplexity: req.query.cardComplexity || 'standard',
      processImages: req.query.processImages === 'true',
      generateConceptMaps: req.query.generateConceptMaps === 'true',
      useOriginalText: req.query.useOriginalText === 'true',
      includeMetadata: req.query.includeMetadata === 'true'
    };
    
    console.log('Card generation preferences:', preferences);
    
    if (!sectionId || !pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    }
    
    // Set up SSE (Server-Sent Events) for progress updates
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Helper function to send progress updates
    const sendProgress = (stage, progress, message, extraData = {}) => {
      res.write(`data: ${JSON.stringify({
        stage,
        progress,
        message,
        ...extraData
      })}\n\n`);
    };
    
    // Track progress
    let currentPage = 0;
    const totalPages = pageIds.length;
    let allFlashcards = [];
    let allImages = [];
    let totalCardCount = 0;
    
    // Initial progress update
    sendProgress('initializing', 0, 'Starting deck generation...');
    
    // Process each page
    for (const pageId of pageIds) {
      currentPage++;
      
      try {
        // Get page info
        sendProgress('loading', Math.floor((currentPage - 0.7) / totalPages * 100), 
          `Loading page ${currentPage} of ${totalPages}...`);
        
        const pages = await getOneNotePages(req, sectionId);
        const pageInfo = pages.find(p => p.id === pageId);
        
        if (!pageInfo) {
          console.warn(`Page ${pageId} not found, skipping...`);
          continue;
        }
        
        const pageTitle = pageInfo.title;
        
        // Extract content
        sendProgress('extracting', Math.floor((currentPage - 0.5) / totalPages * 100), 
          `Extracting content from "${pageTitle}"...`);
        
        const htmlContent = await getPageContent(req, pageId);
        const extractedContent = await extractContentFromOneNoteHtml(req, htmlContent, pageId);
        
        // Process images
        sendProgress('processing_images', Math.floor((currentPage - 0.3) / totalPages * 100), 
          `Processing images from "${pageTitle}"...`);
        
        // Only process images if the setting is enabled
        const processedImages = preferences.processImages ? 
          await processImagesWithAI(extractedContent.images, pageTitle) :
          extractedContent.images.map(img => ({ ...img, analysis: '', potentialQuestions: [] }));
        
        // Track all images for Anki generation
        allImages = [...allImages, ...processedImages];
        
        // Generate concept map
        sendProgress('generating_map', Math.floor((currentPage - 0.2) / totalPages * 100), 
          `Creating concept map for "${pageTitle}"...`);
        
        // Only generate concept maps if the setting is enabled
        const conceptMap = preferences.generateConceptMaps ? 
          await generateConceptMap(extractedContent.text, pageTitle) :
          { concepts: [], relationships: [] };
        
        // Extract flashcards
        sendProgress('creating_cards', Math.floor((currentPage - 0.1) / totalPages * 100), 
          `Generating flashcards for "${pageTitle}"...`);
        
        // Pass user preferences to the flashcard generation function
        const flashcards = await extractFlashcardsWithAI(
          extractedContent.text, 
          pageTitle, 
          conceptMap,
          processedImages,
          preferences
        );
        
        // Apply card limit if set
        let pageFlashcards = flashcards;
        if (preferences.maxCardsPerPage > 0 && flashcards.length > preferences.maxCardsPerPage) {
          pageFlashcards = flashcards.slice(0, preferences.maxCardsPerPage);
        }
        
        // Add page title as a tag to all cards
        const formattedPageTag = pageTitle
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        
        // Add page info to each flashcard
        const taggedFlashcards = pageFlashcards.map(card => ({
          ...card,
          tags: [...(card.tags || []), formattedPageTag],
          sourcePageTitle: pageTitle,
          sourcePageId: pageId
        }));
        
        allFlashcards = [...allFlashcards, ...taggedFlashcards];
        totalCardCount += taggedFlashcards.length;
        
        // Update on page completion
        sendProgress('page_complete', Math.floor(currentPage / totalPages * 100), 
          `Completed ${currentPage} of ${totalPages} pages (${taggedFlashcards.length} cards)`, 
          { cardCount: taggedFlashcards.length });
      } catch (error) {
        console.error(`Error processing page ${pageId}:`, error);
        sendProgress('page_error', Math.floor(currentPage / totalPages * 100), 
          `Error on page ${currentPage}. Continuing with remaining pages...`);
      }
    }
    
    // Generate deck name
    sendProgress('packaging', 95, `Creating Anki package with ${totalCardCount} flashcards...`);
    
    const deckName = `${sectionName.replace(/[^a-zA-Z0-9 ]/g, '')}_${new Date().toISOString().split('T')[0]}`;
    
    try {
      // Prepare data for Python script
      const preparedCards = ankiBridge.prepareCardsForAnki(allFlashcards, allImages);
      const preparedImages = ankiBridge.prepareImagesForAnki(allImages);
      
      // Generate Anki package using Python bridge
      const result = await ankiBridge.generateAnkiPackage({
        cards: preparedCards,
        images: preparedImages,
        deckName: deckName,
        outputDir: UPLOADS_DIR,
        mediaFolder: path.join(__dirname, 'public')
      });
      
      // Return download URL
      const downloadUrl = `/download/${result.filename}`;
      
      // Send final card count message
      const clozeCount = result.stats.cloze || 0;
      const standardCount = result.stats.standard || 0;
      
      sendProgress('complete', 100, 
        `Deck generation complete! Created ${clozeCount} cloze cards and ${standardCount} standard cards.`);
      
      // Send final response
      res.write(`data: ${JSON.stringify({
        complete: true,
        success: true,
        totalPages,
        totalCards: clozeCount + standardCount,
        downloadUrl,
        deckName,
        statistics: {
          cloze: clozeCount,
          standard: standardCount,
          error: result.stats.error || 0
        }
      })}\n\n`);
      
      res.end();
    } catch (error) {
      console.error('Error generating Anki package:', error);
      sendProgress('error', 100, `Error generating Anki package: ${error.message}`);
      
      res.write(`data: ${JSON.stringify({
        error: 'Failed to generate Anki deck',
        complete: true
      })}\n\n`);
      
      res.end();
    }
  } catch (error) {
    console.error('Error in anki generation stream:', error);
    res.write(`data: ${JSON.stringify({
      error: 'Failed to generate Anki deck',
      complete: true
    })}\n\n`);
    res.end();
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
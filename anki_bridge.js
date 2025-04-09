// anki_bridge.js - Bridge between Node.js and Python Anki generator
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

/**
 * Generates an Anki package using the Python script
 * @param {Object} options Configuration options
 * @param {Array} options.cards Array of card objects
 * @param {Array} options.images Array of image objects
 * @param {string} options.deckName Name of the deck
 * @param {string} options.outputDir Directory to save the package
 * @returns {Promise<Object>} Result object with path to the generated package
 */
async function generateAnkiPackage(options) {
  try {
    const {
      cards,
      images = [],
      deckName,
      outputDir = path.join(__dirname, 'uploads'),
      mediaFolder = path.join(__dirname, 'public'),
      pythonPath = 'python3', // or 'python' on Windows
      scriptPath = path.join(__dirname, 'scripts', 'anki_generator.py')
    } = options;

    // Create a unique ID for this generation
    const sessionId = crypto.randomBytes(8).toString('hex');
    
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Create a temp directory for intermediate files
    const tempDir = path.join(os.tmpdir(), `anki_gen_${sessionId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Prepare input data
    const inputData = {
      deckName,
      cards,
      images,
      deckId: parseInt(crypto.createHash('md5').update(deckName).digest('hex').substring(0, 8), 16) % 2147483647
    };

    // Input and output file paths
    const inputJsonPath = path.join(tempDir, `${sessionId}_input.json`);
    const outputApkgPath = path.join(outputDir, `${deckName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}.apkg`);

    // Write input data to JSON file
    fs.writeFileSync(inputJsonPath, JSON.stringify(inputData, null, 2), 'utf8');

    console.log(`Starting Python Anki generation process for deck: ${deckName}`);
    console.log(`Input JSON: ${inputJsonPath}`);
    console.log(`Output APKG: ${outputApkgPath}`);

    // Execute Python script as child process
    return new Promise((resolve, reject) => {
      // Start Python process
      const pythonProcess = spawn(pythonPath, [
        scriptPath,
        inputJsonPath,
        outputApkgPath,
        mediaFolder
      ]);

      let stdoutData = '';
      let stderrData = '';

      // Collect stdout data
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log(`Python stdout: ${data.toString()}`);
      });

      // Collect stderr data
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`Python stderr: ${data.toString()}`);
      });

      // Handle process completion
      pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`);
        
        try {
          // Clean up temp files
          fs.unlinkSync(inputJsonPath);
          fs.rmdirSync(tempDir, { recursive: true });
        } catch (cleanupError) {
          console.warn(`Cleanup error: ${cleanupError.message}`);
        }

        if (code === 0) {
          // Try to parse JSON result from stdout
          try {
            const result = JSON.parse(stdoutData);
            result.filename = path.basename(outputApkgPath);
            resolve(result);
          } catch (parseError) {
            console.error('Error parsing Python output:', parseError);
            resolve({
              success: true,
              filename: path.basename(outputApkgPath),
              path: outputApkgPath,
              stats: {
                cloze: 0,
                standard: 0,
                error: 0
              }
            });
          }
        } else {
          reject(new Error(`Python process failed with code ${code}: ${stderrData}`));
        }
      });

      // Handle process errors
      pythonProcess.on('error', (error) => {
        console.error(`Python process error: ${error.message}`);
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error in generateAnkiPackage:', error);
    throw error;
  }
}

/**
 * Prepares card data for Anki package generation from flashcards array
 * @param {Array} flashcards Array of flashcard objects
 * @param {Array} processedImages Array of processed image objects
 * @returns {Array} Processed cards ready for Anki generation
 */
function prepareCardsForAnki(flashcards, processedImages = []) {
  return flashcards.map(card => {
    // Determine card type
    const isCloze = card.type === 'cloze' || (card.text && card.text.includes('{{c'));
    
    // Format card object for Python script
    return {
      type: isCloze ? 'cloze' : 'standard',
      text: card.text || '',
      question: card.question || '',
      answer: card.answer || '',
      notes: card.notes || '',
      tags: card.tags || [],
      relatedImages: card.relatedImages || []
    };
  });
}

/**
 * Prepares image data for Anki package generation
 * @param {Array} images Array of image objects
 * @returns {Array} Processed images ready for Anki generation
 */
function prepareImagesForAnki(images) {
  return images.map(image => ({
    path: image.path,
    altText: image.altText || '',
    context: image.context || ''
  }));
}

module.exports = {
  generateAnkiPackage,
  prepareCardsForAnki,
  prepareImagesForAnki
};
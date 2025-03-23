# OneNote to Anki Converter

A web application that converts your OneNote notes into Anki-compatible flashcard decks using AI. This application connects to your Microsoft OneNote account, extracts content from selected notebooks and sections, and generates downloadable Anki packages (.apkg files) that you can import directly into Anki.

## Features

- **Microsoft Authentication**: Securely connect to your OneNote account using OAuth 2.0
- **AI-Powered Conversion**: Automatically generate high-quality flashcards from your notes
- **Selective Conversion**: Choose specific pages to include in your Anki deck
- **Tagged Organization**: Flashcards are automatically tagged based on their source page
- **Anki Integration**: Download decks in .apkg format for seamless import into Anki

## Prerequisites

- Node.js (v16 or newer)
- Microsoft account with OneNote
- Google AI API key for Gemini
- Anki installed on your computer (to use the generated decks)

## Setup

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/onenote-to-anki.git
   cd onenote-to-anki
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a Microsoft Entra (Azure AD) application:
   - Go to [Microsoft Entra admin center](https://entra.microsoft.com/)
   - Navigate to "App registrations" and create a new registration
   - Set the redirect URI to `http://localhost:3000/auth/callback` (or your custom URL)
   - Under "API permissions", add permissions for "Microsoft Graph" > "Notes.Read" and "User.Read"
   - Create a client secret

4. Get a Google AI API key for Gemini:
   - Go to [Google AI Studio](https://aistudio.google.com/)
   - Create a new API key

5. Create a `.env` file based on the template:
   ```
   cp .env.template .env
   ```
   
6. Fill in your credentials in the `.env` file

7. Start the server:
   ```
   npm start
   ```

8. Open your browser and navigate to `http://localhost:3000`

## Deployment

This application can be deployed to various platforms:

### Fly.io

1. Install the Fly CLI
2. Run `fly launch` in the project directory
3. Set up secrets with `fly secrets set KEY=VALUE`
4. Deploy with `fly deploy`

### Docker

A Dockerfile is included for containerized deployment:

```bash
docker build -t onenote-to-anki .
docker run -p 3000:3000 --env-file .env onenote-to-anki
```

## Usage Instructions

1. Sign in with your Microsoft account
2. Select a notebook and section from your OneNote
3. Click "Scan Pages" to see available pages
4. Select the pages you want to convert into flashcards
5. Click "Generate Anki Deck" and wait for processing
6. Download the generated .apkg file
7. Open Anki and import the file via File > Import

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
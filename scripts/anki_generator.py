#!/usr/bin/env python3
import sys
import json
import os
import random
import logging
import genanki
import shutil
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, 
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
                    stream=sys.stdout)
logger = logging.getLogger("AnkiGenerator")

# Fixed model IDs for consistency
CLOZE_MODEL_ID = 1607392319
BASIC_MODEL_ID = 1380120668 

# Define the cloze model (standard Anki cloze model)
cloze_model = genanki.Model(
    CLOZE_MODEL_ID,
    'Cloze',
    fields=[
        {'name': 'Text'},   # Front side with cloze deletions
        {'name': 'Extra'},  # Back side with additional info
    ],
    templates=[
        {
            'name': 'Cloze',
            'qfmt': '{{cloze:Text}}',
            'afmt': '{{cloze:Text}}<hr id=answer>{{Extra}}',
        },
    ],
    model_type=genanki.Model.CLOZE
)

# Define the basic model (standard Q&A format)
basic_model = genanki.Model(
    BASIC_MODEL_ID,
    'Basic',
    fields=[
        {'name': 'Front'},  # Question
        {'name': 'Back'},   # Answer
    ],
    templates=[
        {
            'name': 'Card 1',
            'qfmt': '{{Front}}',
            'afmt': '{{FrontSide}}<hr id=answer>{{Back}}',
        },
    ]
)

def process_input_data(input_json_path):
    """Read and process the input JSON data"""
    try:
        with open(input_json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        logger.info(f"Successfully loaded JSON data from {input_json_path}")
        return data
    except Exception as e:
        logger.error(f"Error loading JSON: {str(e)}")
        raise

def create_anki_package(data, output_path, media_folder):
    """Create an Anki package from the provided data"""
    try:
        # Extract components from data
        deck_name = data.get('deckName', 'OneNote Converted Deck')
        cards_data = data.get('cards', [])
        images = data.get('images', [])
        
        # Create deck with consistent ID generation based on name
        # This helps if the user regenerates the same deck
        deck_id = random.randrange(1 << 30, 1 << 31)
        if 'deckId' in data:
            # Use provided ID if available
            deck_id = data['deckId']
            
        deck = genanki.Deck(deck_id, deck_name)
        
        # Statistics tracking
        stats = {
            'cloze': 0,
            'standard': 0,
            'error': 0
        }
        
        # Process each card
        for card in cards_data:
            try:
                card_type = card.get('type', 'standard')
                tags = card.get('tags', [])
                
                # Convert tags to string array if needed
                if isinstance(tags, str):
                    tags = [t.strip() for t in tags.split() if t.strip()]
                
                # Handle cloze cards
                if card_type == 'cloze':
                    cloze_text = card.get('text', '')
                    extra_text = card.get('notes', '')
                    
                    # Ensure the cloze text has at least one cloze marker
                    if '{{c' not in cloze_text:
                        # Try to find meaningful words to create a cloze
                        words = cloze_text.split()
                        for i, word in enumerate(words):
                            if len(word) > 5 and word.isalpha() and word.lower() not in ['about', 'there', 'their', 'would', 'could', 'should']:
                                cloze_text = cloze_text.replace(word, f"{{{{c1::{word}}}}}", 1)
                                break
                    
                    # Create and add the note
                    note = genanki.Note(
                        model=cloze_model,
                        fields=[cloze_text, extra_text],
                        tags=tags
                    )
                    deck.add_note(note)
                    stats['cloze'] += 1
                
                # Handle standard Q&A cards
                else:
                    front = card.get('question', '')
                    back = card.get('answer', '')
                    
                    # Add notes if available
                    if card.get('notes'):
                        back += f"<hr>{card['notes']}"
                    
                    note = genanki.Note(
                        model=basic_model,
                        fields=[front, back],
                        tags=tags
                    )
                    deck.add_note(note)
                    stats['standard'] += 1
            
            except Exception as e:
                logger.error(f"Error processing card: {str(e)}")
                stats['error'] += 1
                continue
        
        # Create package and add any media files
        package = genanki.Package(deck)
        media_files = []
        
        # Process images
        for image in images:
            source_path = os.path.join(media_folder, os.path.basename(image['path']))
            if os.path.exists(source_path):
                media_files.append(source_path)
            else:
                logger.warning(f"Image file not found: {source_path}")
        
        # Add media files to package
        if media_files:
            package.media_files = media_files
        
        # Save the package
        package.write_to_file(output_path)
        
        logger.info(f"Successfully created Anki package at {output_path}")
        logger.info(f"Card statistics: {stats}")
        
        return {
            'success': True,
            'stats': stats,
            'path': output_path
        }
    
    except Exception as e:
        logger.error(f"Error creating Anki package: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

def main():
    """Main entry point for the script"""
    if len(sys.argv) < 3:
        logger.error("Usage: python anki_generator.py <input_json_path> <output_apkg_path> [media_folder]")
        sys.exit(1)
    
    input_json_path = sys.argv[1]
    output_apkg_path = sys.argv[2]
    media_folder = sys.argv[3] if len(sys.argv) > 3 else os.path.dirname(input_json_path)
    
    # Create output directory if it doesn't exist
    os.makedirs(os.path.dirname(output_apkg_path), exist_ok=True)
    
    try:
        # Process data and create package
        data = process_input_data(input_json_path)
        result = create_anki_package(data, output_apkg_path, media_folder)
        
        # Return results as JSON to stdout
        print(json.dumps(result))
        
        # Exit with success code if everything worked
        if result['success']:
            sys.exit(0)
        else:
            sys.exit(1)
            
    except Exception as e:
        logger.error(f"Unhandled exception: {str(e)}")
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
# Improved test script to generate an Anki package with concept maps and images
# Install with: pip install genanki
import genanki
import random
import os
import shutil
import base64

# Define a cloze model (this is the standard Anki cloze model)
cloze_model = genanki.Model(
    1607392319,  # Fixed model ID
    'Cloze',
    fields=[
        {'name': 'Text'},   # This field contains the cloze text
        {'name': 'Extra'},  # This field contains notes/concept maps
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

# Create a deck
deck = genanki.Deck(
    random.randrange(1 << 30, 1 << 31),  # Random deck ID
    'Test Cloze With Concept Maps and Images'
)

# Create a media folder for images
os.makedirs('test_media', exist_ok=True)

# Function to create a sample image for testing
def create_sample_image(filename, color='blue'):
    # Create a base64 encoded SVG image
    svg_content = f'''
    <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="100" fill="{color}" />
        <text x="50%" y="50%" font-family="Arial" font-size="16" 
              fill="white" text-anchor="middle" dominant-baseline="middle">
            {filename}
        </text>
    </svg>
    '''
    
    # Save the SVG to the media folder
    with open(f'test_media/{filename}', 'w') as f:
        f.write(svg_content)
    
    return filename

# Create sample images
img1 = create_sample_image('anatomy_diagram.svg', 'darkblue')
img2 = create_sample_image('crc_stages.svg', 'darkgreen')
img3 = create_sample_image('hemorrhoid_types.svg', 'darkred')
img4 = create_sample_image('cell_division.svg', 'purple')

# ========== EXAMPLE 1: COLORECTAL CANCER STAGING CONCEPT MAP ==========
crc_concept_map = '''
<div class="anki-notes">
  <h2>Concept Map: CRC Staging</h2>
  
  <h3>T Staging Classifications</h3>
  <ul>
    <li>• <span class="relationship"><strong>T1</strong> → <strong>Submucosa</strong></span> (invasion limited to submucosa)<br></li>
    <li>• <span class="relationship"><strong>T2</strong> → <strong>Muscularis propria</strong></span> (invasion into but not through muscularis propria)<br></li>
    <li>• <span class="relationship"><strong>T3</strong> → <strong>Subserosa/Pericolic tissues</strong></span> (invasion through muscularis propria)<br></li>
    <li>• <span class="relationship"><strong>T4a</strong> → <strong>Visceral peritoneum</strong></span> (penetration of visceral peritoneum)<br></li>
    <li>• <span class="relationship"><strong>T4b</strong> → <strong>Adjacent organs</strong></span> (direct invasion of other organs/structures)<br></li>
  </ul>
  
  <h3>Relationships</h3>
  <ul>
    <li>• <span class="relationship"><strong>T Stage</strong> → <strong>Prognosis</strong></span> (determines outcome)<br>
       <em>Higher T stage correlates with worse prognosis</em><br></li>
    <li>• <span class="relationship"><strong>T Stage</strong> → <strong>Treatment approach</strong></span> (influences management)<br>
       <em>Higher T stages may require more aggressive treatment</em><br></li>
  </ul>
  
  <h3>Related Concepts</h3>
  <ul>
    <li>• <span class="relationship"><strong>TNM staging</strong> ⊃ <strong>T Stage</strong></span> (T is part of TNM)<br></li>
    <li>• <span class="relationship"><strong>Bowel wall anatomy</strong> → <strong>T staging</strong></span> (anatomical basis)<br></li>
  </ul>
  
  <h2>Images</h2>
  <img src="crc_stages.svg" style="max-width: 100%; margin: 10px 0;"><br>
  <em>Diagram showing progressive invasion through bowel wall layers</em>
</div>
<style>
.anki-notes h2 {
  color: #2196F3;
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 6px;
  margin-top: 15px;
  margin-bottom: 10px;
}
.anki-notes h3 {
  color: #1976D2;
  margin-top: 12px;
  margin-bottom: 8px;
}
.anki-notes .relationship {
  color: #4CAF50;
  font-weight: bold;
}
.anki-notes em {
  color: #607D8B;
}
.anki-notes ul {
  padding-left: 20px;
  list-style-type: none;
}
</style>
'''

# ========== EXAMPLE 2: CELL DIVISION CONCEPT MAP ==========
cell_division_map = '''
<div class="anki-notes">
  <h2>Concept Map: Cell Division</h2>
  
  <h3>Process Phases</h3>
  <ul>
    <li>• <span class="relationship"><strong>Interphase</strong> → <strong>Prophase</strong></span> (sequential steps)<br>
       <em>Cell prepares genetic material before visible condensation</em><br></li>
    <li>• <span class="relationship"><strong>Prophase</strong> → <strong>Metaphase</strong></span> (sequential steps)<br>
       <em>Chromosomes line up at the metaphase plate</em><br></li>
    <li>• <span class="relationship"><strong>Metaphase</strong> → <strong>Anaphase</strong></span> (sequential steps)<br>
       <em>Sister chromatids separate to opposite poles</em><br></li>
    <li>• <span class="relationship"><strong>Anaphase</strong> → <strong>Telophase</strong></span> (sequential steps)<br>
       <em>Nuclear envelope reforms around separated chromosomes</em><br></li>
    <li>• <span class="relationship"><strong>Telophase</strong> → <strong>Cytokinesis</strong></span> (sequential steps)<br>
       <em>Cytoplasm divides, creating two daughter cells</em><br></li>
  </ul>
  
  <h3>Key Regulators</h3>
  <ul>
    <li>• <span class="relationship"><strong>Cyclins</strong> ⟶ <strong>Cell Cycle Progression</strong></span> (regulate)<br></li>
    <li>• <span class="relationship"><strong>Cyclin-dependent kinases (CDKs)</strong> ⟶ <strong>Cell Cycle Checkpoints</strong></span> (control)<br></li>
    <li>• <span class="relationship"><strong>p53</strong> ⟶ <strong>DNA Damage Checkpoint</strong></span> (monitors)<br></li>
  </ul>
  
  <h3>Mitosis vs. Meiosis</h3>
  <ul>
    <li>• <span class="relationship"><strong>Mitosis</strong> → <strong>Identical diploid cells</strong></span> (produces)<br></li>
    <li>• <span class="relationship"><strong>Meiosis</strong> → <strong>Haploid gametes</strong></span> (produces)<br></li>
    <li>• <span class="relationship"><strong>Meiosis</strong> ⊃ <strong>Crossing over</strong></span> (includes process)<br></li>
  </ul>
  
  <h2>Images</h2>
  <img src="cell_division.svg" style="max-width: 100%; margin: 10px 0;"><br>
  <em>Diagram showing stages of cell division process</em>
</div>
<style>
.anki-notes h2 {
  color: #2196F3;
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 6px;
  margin-top: 15px;
  margin-bottom: 10px;
}
.anki-notes h3 {
  color: #1976D2;
  margin-top: 12px;
  margin-bottom: 8px;
}
.anki-notes .relationship {
  color: #4CAF50;
  font-weight: bold;
}
.anki-notes em {
  color: #607D8B;
}
.anki-notes ul {
  padding-left: 20px;
  list-style-type: none;
}
</style>
'''

# ========== EXAMPLE 3: HEMORRHOID TYPES CONCEPT MAP ==========
hemorrhoid_map = '''
<div class="anki-notes">
  <h2>Concept Map: Hemorrhoids</h2>
  
  <h3>Classification Types</h3>
  <ul>
    <li>• <span class="relationship"><strong>External hemorrhoids</strong> ← <strong>located below dentate line</strong></span> (anatomical position)<br>
       <em>Covered by anoderm and perianal skin with somatic innervation</em><br></li>
    <li>• <span class="relationship"><strong>Internal hemorrhoids</strong> ← <strong>located above dentate line</strong></span> (anatomical position)<br>
       <em>Covered by rectal mucosa with visceral innervation</em><br></li>
    <li>• <span class="relationship"><strong>Mixed hemorrhoids</strong> = <strong>internal + external components</strong></span> (combination)<br></li>
  </ul>
  
  <h3>Symptoms by Type</h3>
  <ul>
    <li>• <span class="relationship"><strong>External hemorrhoids</strong> → <strong>Pain</strong></span> (when thrombosed)<br></li>
    <li>• <span class="relationship"><strong>Internal hemorrhoids</strong> → <strong>Painless bleeding</strong></span> (common symptom)<br></li>
    <li>• <span class="relationship"><strong>Internal hemorrhoids</strong> → <strong>Prolapse</strong></span> (advanced cases)<br></li>
  </ul>
  
  <h3>Pathophysiology</h3>
  <ul>
    <li>• <span class="relationship"><strong>Increased venous pressure</strong> → <strong>Hemorrhoid development</strong></span> (causative)<br></li>
    <li>• <span class="relationship"><strong>Straining</strong> → <strong>Increased venous pressure</strong></span> (mechanism)<br></li>
    <li>• <span class="relationship"><strong>Thrombosis</strong> → <strong>Pain in external hemorrhoids</strong></span> (mechanism)<br>
       <em>Thrombosis causes distention and inflammation of innervated perianal skin</em><br></li>
  </ul>
  
  <h2>Images</h2>
  <img src="hemorrhoid_types.svg" style="max-width: 100%; margin: 10px 0;"><br>
  <em>Illustration showing internal and external hemorrhoid anatomy</em>
</div>
<style>
.anki-notes h2 {
  color: #2196F3;
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 6px;
  margin-top: 15px;
  margin-bottom: 10px;
}
.anki-notes h3 {
  color: #1976D2;
  margin-top: 12px;
  margin-bottom: 8px;
}
.anki-notes .relationship {
  color: #4CAF50;
  font-weight: bold;
}
.anki-notes em {
  color: #607D8B;
}
.anki-notes ul {
  padding-left: 20px;
  list-style-type: none;
}
</style>
'''

# ========== EXAMPLE 4: ANATOMY CONCEPT MAP ==========
anatomy_map = '''
<div class="anki-notes">
  <h2>Concept Map: GI Tract Anatomy</h2>
  
  <h3>Layer Structure (from inside out)</h3>
  <ul>
    <li>• <span class="relationship"><strong>Mucosa</strong> → <strong>Innermost layer</strong></span> (location)<br>
       <em>Consists of epithelium, lamina propria, and muscularis mucosae</em><br></li>
    <li>• <span class="relationship"><strong>Submucosa</strong> → <strong>Second layer</strong></span> (location)<br>
       <em>Contains Meissner's (submucosal) plexus and blood vessels</em><br></li>
    <li>• <span class="relationship"><strong>Muscularis propria</strong> → <strong>Third layer</strong></span> (location)<br>
       <em>Inner circular and outer longitudinal muscle layers with Auerbach's (myenteric) plexus</em><br></li>
    <li>• <span class="relationship"><strong>Serosa/Adventitia</strong> → <strong>Outermost layer</strong></span> (location)<br>
       <em>Serosa is the visceral peritoneum, adventitia is connective tissue</em><br></li>
  </ul>
  
  <h3>Specialized Structures</h3>
  <ul>
    <li>• <span class="relationship"><strong>Enteric nervous system</strong> ⊃ <strong>Myenteric plexus</strong></span> (component)<br></li>
    <li>• <span class="relationship"><strong>Enteric nervous system</strong> ⊃ <strong>Submucosal plexus</strong></span> (component)<br></li>
    <li>• <span class="relationship"><strong>Mucosa</strong> ⊃ <strong>Epithelium</strong></span> (component)<br></li>
    <li>• <span class="relationship"><strong>Mucosa</strong> ⊃ <strong>Lamina propria</strong></span> (component)<br></li>
  </ul>
  
  <h3>Clinical Relevance</h3>
  <ul>
    <li>• <span class="relationship"><strong>T1 invasion</strong> → <strong>Submucosa</strong></span> (involves)<br></li>
    <li>• <span class="relationship"><strong>T2 invasion</strong> → <strong>Muscularis propria</strong></span> (involves)<br></li>
    <li>• <span class="relationship"><strong>T3 invasion</strong> → <strong>Through muscularis into subserosa</strong></span> (involves)<br></li>
    <li>• <span class="relationship"><strong>T4 invasion</strong> → <strong>Serosa or adjacent organs</strong></span> (involves)<br></li>
  </ul>
  
  <h2>Images</h2>
  <img src="anatomy_diagram.svg" style="max-width: 100%; margin: 10px 0;"><br>
  <em>Cross-section showing layers of the intestinal wall</em>
</div>
<style>
.anki-notes h2 {
  color: #2196F3;
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 6px;
  margin-top: 15px;
  margin-bottom: 10px;
}
.anki-notes h3 {
  color: #1976D2;
  margin-top: 12px;
  margin-bottom: 8px;
}
.anki-notes .relationship {
  color: #4CAF50;
  font-weight: bold;
}
.anki-notes em {
  color: #607D8B;
}
.anki-notes ul {
  padding-left: 20px;
  list-style-type: none;
}
</style>
'''

# Create cloze notes with concept maps
notes = [
    # Example 1: Colorectal Cancer Staging
    genanki.Note(
        model=cloze_model,
        fields=[
            'T1: Tumor invades {{c1::submucosa}} - T2: Tumor invades {{c2::muscularis propria}} - T3: Tumor invades through muscularis propria into {{c3::subserosa}} or non-peritonealized pericolic/rectal tissues',
            crc_concept_map
        ],
        tags=['pathophysiology', 'colorectal_cancer', 'staging']
    ),
    
    # Example 2: Cell Division Process
    genanki.Note(
        model=cloze_model,
        fields=[
            'Cell division phases in sequence: {{c1::Interphase}} → {{c2::Prophase}} → {{c3::Metaphase}} → {{c4::Anaphase}} → {{c5::Telophase}} → {{c6::Cytokinesis}}',
            cell_division_map
        ],
        tags=['cell_biology', 'cell_division', 'process']
    ),
    
    # Example 3: Hemorrhoid Types
    genanki.Note(
        model=cloze_model,
        fields=[
            'A thrombosed {{c1::external}} hemorrhoid causes {{c2::pain}} due to inflammation and distention of the overlying somatically-innervated perianal skin.',
            hemorrhoid_map
        ],
        tags=['hemorrhoids', 'pain', 'pathophysiology']
    ),
    
    # Example 4: GI Tract Layers
    genanki.Note(
        model=cloze_model,
        fields=[
            'The layers of the GI tract from innermost to outermost are: {{c1::Mucosa}} → {{c2::Submucosa}} → {{c3::Muscularis propria}} → {{c4::Serosa/Adventitia}}',
            anatomy_map
        ],
        tags=['anatomy', 'GI_tract', 'layers']
    )
]

# Add notes to the deck
for note in notes:
    deck.add_note(note)

# Create the package with media files
package = genanki.Package(deck)
package.media_files = [
    'test_media/anatomy_diagram.svg',
    'test_media/crc_stages.svg',
    'test_media/hemorrhoid_types.svg', 
    'test_media/cell_division.svg'
]

# Output the package
package.write_to_file('test_cloze_with_concept_maps_and_images.apkg')

print("Package generated: test_cloze_with_concept_maps_and_images.apkg")
print("Import this file into Anki to test the cloze cards with formatted concept maps and images")

# Cleanup
# Uncomment if you want to clean up the test_media directory after running
# shutil.rmtree('test_media')
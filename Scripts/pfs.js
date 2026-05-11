// Scripts/pfs.js
// This script prints the folder structure of the project, excluding certain directories.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Determine the script's directory and project root
const scriptPath = __filename;
const scriptDir = path.dirname(scriptPath);
const projectRoot = path.dirname(scriptDir);

console.log(`Project root is: ${projectRoot}`);

// Define folders to exclude
const excludeFolders = [
  "dist",
  ".next",
  ".gi",
  ".github",
  "node_modules",
  "__pycache",
  "court_management/__pycache",
  "court_management/management/commands/__pycache__",
  "court_management/management/migrations/__pycache__",
  "court_management/templatetags/__pycache__",
  "venv"
].map(folder => path.join(projectRoot, folder));

console.log("Excluded folders:", excludeFolders);

/**
 * Print folder structure recursively
 * @param {string} dirPath - The directory path to traverse
 * @param {string[]} excludeFolders - Array of folder paths to exclude
 * @param {number} maxDepth - Maximum depth to traverse
 * @param {number} currentDepth - Current depth level
 * @param {string} prefix - Prefix for tree structure visualization
 * @returns {string} - The folder structure as a string
 */
function printFolderStructure(dirPath, excludeFolders, maxDepth = 3, currentDepth = 0, prefix = '') {
  let output = '';
  
  if (currentDepth >= maxDepth) {
    return output;
  }

  try {
    const items = fs.readdirSync(dirPath);
    
    items.forEach((item, index) => {
      const fullPath = path.join(dirPath, item);
      
      // Check if this path should be excluded
      if (excludeFolders.some(excluded => fullPath.startsWith(excluded))) {
        return;
      }

      const isLast = index === items.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const newPrefix = isLast ? '    ' : '│   ';

      try {
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory()) {
          output += `${prefix}${connector}${item}/\n`;
          output += printFolderStructure(
            fullPath,
            excludeFolders,
            maxDepth,
            currentDepth + 1,
            prefix + newPrefix
          );
        } else {
          output += `${prefix}${connector}${item}\n`;
        }
      } catch (err) {
        // Skip files/folders that can't be accessed
        console.error(`Error accessing ${fullPath}:`, err.message);
      }
    });
  } catch (err) {
    console.error(`Error reading directory ${dirPath}:`, err.message);
  }

  return output;
}

// Generate the folder structure
const folderStructure = `${path.basename(projectRoot)}/\n` + 
  printFolderStructure(projectRoot, excludeFolders, 4);

// Write to file
const outputFile = path.join(projectRoot, 'folderstructure.txt');
fs.writeFileSync(outputFile, folderStructure, 'utf8');

console.log(`\nFolder structure written to: ${outputFile}`);

// Open the file with VS Code (if available)
try {
  execSync(`code "${outputFile}"`, { stdio: 'inherit' });
} catch (err) {
  console.log('Could not open file with VS Code. Please open manually.');
}
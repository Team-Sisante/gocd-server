/*
// Scripts/pfs.js
// This script prints the folder structure of a project (or any folder), excluding certain directories.
// Usage: node Scripts/pfs.js [target-folder]
//   - If no folder is given, the project root (one level up from Scripts/) is used.
//   - If a folder is given, its structure is printed instead.

  Example usage:
    node Scripts/pfs.js /c/repo
    # or
    node Scripts/pfs.js C:/repo
*/


const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Determine the script's directory and the default project root
const scriptPath = __filename;
const scriptDir = path.dirname(scriptPath);
const defaultProjectRoot = path.dirname(scriptDir);

// Allow the user to specify a different target folder via command-line argument
const userTarget = process.argv[2];
const targetRoot = userTarget ? path.resolve(userTarget) : defaultProjectRoot;

console.log(`Target folder: ${targetRoot}`);

// Define folders to exclude (relative names – they will be mapped to full paths under targetRoot)
const excludeRelative = [
  "dist",
  ".next",
  ".gi",
  ".github",
  "node_modules",
  "__pycache__",
  "court_management/__pycache__",
  "court_management/management/commands/__pycache__",
  "court_management/management/migrations/__pycache__",
  "court_management/templatetags/__pycache__",
  "venv"
];

// Convert relative exclusions to absolute paths inside the target folder
const excludeFolders = excludeRelative.map(folder => path.join(targetRoot, folder));
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
const folderStructure = `${path.basename(targetRoot)}/\n` + 
  printFolderStructure(targetRoot, excludeFolders, 4);

// Write the result to a file inside the target folder (same name for consistency)
const outputFile = path.join(targetRoot, 'folderstructure.txt');
fs.writeFileSync(outputFile, folderStructure, 'utf8');

console.log(`\nFolder structure written to: ${outputFile}`);

// Try to open the file with VS Code (if available)
try {
  execSync(`code "${outputFile}"`, { stdio: 'inherit' });
} catch (err) {
  console.log('Could not open file with VS Code. Please open manually.');
}
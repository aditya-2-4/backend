import sys
import os

# Add ai-service directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'ai-service'))

from main import app

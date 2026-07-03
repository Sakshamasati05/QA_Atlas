import React, { useState, useEffect, useRef, useCallback } from 'react';
import './ChatAssistant.css';

const BACKEND_URL = 'http://localhost:5000/api';
const generateChatId = () => 'CHAT-' + Date.now();

export default function ChatAssistant() {
  // Navigation Tabs
  const [activeTab, setActiveTab] = useState('generator'); // 'generator', 'repository', 'history'

  // Settings & User Segregation State
  const [userId, setUserId] = useState(() => localStorage.getItem('qatlas_userId') || 'Alex Morgan');
  const [provider, setProvider] = useState(() => localStorage.getItem('qatlas_provider') || 'gemini');
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem('qatlas_geminiKey') || '');
  const [claudeKey, setClaudeKey] = useState(() => localStorage.getItem('qatlas_claudeKey') || '');
  const [openaiKey, setOpenaiKey] = useState(() => localStorage.getItem('qatlas_openaiKey') || '');
  const [copilotKey, setCopilotKey] = useState(() => localStorage.getItem('qatlas_copilotKey') || '');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempUserId, setTempUserId] = useState(userId);
  const [tempProvider, setTempProvider] = useState(provider);
  const [tempGeminiKey, setTempGeminiKey] = useState(geminiKey);
  const [tempClaudeKey, setTempClaudeKey] = useState(claudeKey);
  const [tempOpenaiKey, setTempOpenaiKey] = useState(openaiKey);
  const [tempCopilotKey, setTempCopilotKey] = useState(copilotKey);
  const [theme, setTheme] = useState(() => localStorage.getItem('qatlas_theme') || 'light');

  // QAtlas Generator Input Form
  const [userStory, setUserStory] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [format, setFormat] = useState('Default');

  const getCustomField = (tc, fieldName) => {
    if (!tc || !tc.customFields) return '';
    try {
      const parsed = typeof tc.customFields === 'string' ? JSON.parse(tc.customFields) : tc.customFields;
      return parsed[fieldName] || '';
    } catch (e) {
      return '';
    }
  };

  const updateCustomField = (fieldName, value) => {
    const currentFields = typeof editingTcData.customFields === 'string'
      ? JSON.parse(editingTcData.customFields || '{}')
      : (editingTcData.customFields || {});
    setEditingTcData({
      ...editingTcData,
      customFields: {
        ...currentFields,
        [fieldName]: value
      }
    });
  };
  const [positiveCount, setPositiveCount] = useState(3);
  const [negativeCount, setNegativeCount] = useState(3);
  const [edgeCount, setEdgeCount] = useState(3);
  const [securityCount, setSecurityCount] = useState(2);
  const [performanceCount, setPerformanceCount] = useState(2);
  const [customizeVolume, setCustomizeVolume] = useState(false);

  // Context Upload state
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);

  // Chat History & Messages State
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  // Test Cases State
  const [activeStory, setActiveStory] = useState(null); // Loaded user story object
  const [testCases, setTestCases] = useState([]);
  const [editingTcId, setEditingTcId] = useState(null);
  const [editingTcData, setEditingTcData] = useState({});
  const [duplicateCount, setDuplicateCount] = useState(0);

  // BDD Gherkin state
  const [bddModes, setBddModes] = useState({}); // tcId -> boolean
  const [cardViews, setCardViews] = useState({}); // tcId -> 'manual' | 'gherkin' | 'playwright' | 'cypress'
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Dry-Run Simulator State
  const [dryRunCases, setDryRunCases] = useState(null); // null means inactive
  const [currentDryRunIndex, setCurrentDryRunIndex] = useState(0);
  const [dryRunStepChecks, setDryRunStepChecks] = useState({});
  const [dryRunComments, setDryRunComments] = useState('');

  // Jira Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  // Past User Stories (History Dashboard)
  const [pastStories, setPastStories] = useState([]);
  const [loadingStories, setLoadingStories] = useState(false);

  // Fetch initial chat and story history for current user on load/change
  useEffect(() => {
    fetchChats();
    fetchPastStories();
  }, [userId]);

  useEffect(() => {
    document.body.className = theme === 'light' ? 'light-theme' : 'dark-theme';
    localStorage.setItem('qatlas_theme', theme);
  }, [theme]);

  // Synchronize generator panel inputs and test cases when active chat changes
  const lastLoadedChatIdRef = useRef(null);
  useEffect(() => {
    if (lastLoadedChatIdRef.current === activeChatId && pastStories.length > 0 && activeStory) return;

    if (!activeChatId) {
      setUserStory('');
      setAcceptanceCriteria('');
      setUploadedFiles([]);
      setActiveStory(null);
      setTestCases([]);
      setDuplicateCount(0);
      lastLoadedChatIdRef.current = null;
      return;
    }

    const story = pastStories.find(s => s.chatId === activeChatId);
    if (story) {
      setActiveStory(story);
      setUserStory(story.description || '');
      const acText = story.acceptanceCriteria ? story.acceptanceCriteria.map(ac => ac.content).join('\n') : '';
      setAcceptanceCriteria(acText);
      setTestCases(story.testCases || []);
      setDuplicateCount(0);
      lastLoadedChatIdRef.current = activeChatId;
    } else {
      setUserStory('');
      setAcceptanceCriteria('');
      setUploadedFiles([]);
      setActiveStory(null);
      setTestCases([]);
      setDuplicateCount(0);
      lastLoadedChatIdRef.current = activeChatId;
    }
  }, [activeChatId, pastStories]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const fetchChats = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/chats?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      setChats(data);
      if (data.length > 0 && !activeChatId) {
        setActiveChatId(data[0].id);
      }
    } catch (err) {
      console.error('Failed to fetch chats:', err);
    }
  };

  const fetchPastStories = async () => {
    setLoadingStories(true);
    try {
      const res = await fetch(`${BACKEND_URL}/user-stories?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      setPastStories(data);
    } catch (err) {
      console.error('Failed to fetch past stories:', err);
    } finally {
      setLoadingStories(false);
    }
  };

  const createNewChat = () => {
    const newId = generateChatId();
    setChats([{ id: newId, title: 'New QAtlas Session', messages: [] }, ...chats]);
    setActiveChatId(newId);
    setSidebarOpen(false);
    setUserStory('');
    setAcceptanceCriteria('');
    setUploadedFiles([]);
    setActiveStory(null);
    setTestCases([]);
    setDuplicateCount(0);
    setActiveTab('generator');
  };

  // --- Document File Upload ---
  const handleFiles = useCallback(async (files) => {
    setUploadError('');
    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach(f => formData.append('files', f));
    try {
      const res = await fetch(`${BACKEND_URL}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        setUploadedFiles(prev => [...prev, ...data.files]);
      } else {
        setUploadError(data.error || 'Upload failed.');
      }
    } catch (err) {
      setUploadError('Could not reach server. Is the backend running?');
    } finally {
      setIsUploading(false);
    }
  }, []);

  const onFileInputChange = (e) => { if (e.target.files.length) handleFiles(e.target.files); };
  const onDrop = (e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); };
  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const removeFile = (idx) => setUploadedFiles(prev => prev.filter((_, i) => i !== idx));

  // --- QAtlas Generation ---
  const handleGenerateTestCases = async () => {
    if (!userStory.trim() && !acceptanceCriteria.trim()) return;
    let currentChatId = activeChatId;
    if (!currentChatId) {
      currentChatId = generateChatId();
      setActiveChatId(currentChatId);
    }

    setIsTyping(true);

    // Build context
    let docContext = '';
    if (uploadedFiles.length > 0) {
      docContext = uploadedFiles.map(f => `[Context File: ${f.name}]\n${f.text}`).join('\n\n');
    }

    // Temporarily add user prompt message to sidebar
    setChats(prev => {
      const chatIndex = prev.findIndex(c => c.id === currentChatId);
      const tempUserMsg = { 
        id: 'temp', 
        role: 'user', 
        content: `Generate QAtlas Test Cases.\nUser Story: ${userStory}\nAcceptance Criteria: ${acceptanceCriteria}` 
      };
      if (chatIndex === -1) {
        return [{ id: currentChatId, title: userStory.substring(0, 20) || 'Generated Tests', messages: [tempUserMsg] }, ...prev];
      }
      const newChats = [...prev];
      newChats[chatIndex].messages.push(tempUserMsg);
      return newChats;
    });

    try {
      const activeKey = provider === 'claude' ? claudeKey : provider === 'chatgpt' ? openaiKey : provider === 'copilot' ? copilotKey : geminiKey;
      const headers = { 
        'Content-Type': 'application/json',
        'x-provider': provider
      };
      if (activeKey) headers['x-api-key'] = activeKey;

      const res = await fetch(`${BACKEND_URL}/user-stories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userStory,
          acceptanceCriteria,
          docContext,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          customizeVolume,
          userId,
          chatId: currentChatId,
          format
        })
      });

      if (res.ok) {
        const data = await res.json();
        setDuplicateCount(data.duplicateCount || 0);
        setTestCases(data.testCases || []);
        
        // Fetch details of active story
        setActiveStory(data.story || {
          id: data.storyId,
          title: userStory.substring(0, 50) || 'Untitled Story',
          description: userStory,
          userId
        });
        
        // Clear uploaded files & context
        setUploadedFiles([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }

        // Refresh sidebar and story list
        await fetchChats();
        await fetchPastStories();
        
        // Route immediately to repository tab to let them view/edit
        setActiveTab('repository');
      }
    } catch (err) {
      console.error('Failed to generate test cases:', err);
      // Clean up temp message on failure
      setChats(prev => prev.map(c =>
        c.id === currentChatId
          ? { ...c, messages: c.messages.filter(m => m.id !== 'temp') }
          : c
      ));
    } finally {
      setIsTyping(false);
    }
  };

  // --- Auto-Generate from Document ---
  const handleGenerateFromDoc = async (file) => {
    let currentChatId = activeChatId;
    if (!currentChatId) {
      currentChatId = generateChatId();
      setActiveChatId(currentChatId);
    }

    setIsTyping(true);
    setActiveTab('generator');

    const tempId = 'temp-' + Date.now();
    // Optimistically add user chat message
    setChats(prev => {
      const chatIndex = prev.findIndex(c => c.id === currentChatId);
      const tempUserMsg = { 
        id: tempId, 
        role: 'user', 
        content: `Extract requirements and generate QAtlas test cases from document: ${file.name}` 
      };
      if (chatIndex === -1) {
        return [{ id: currentChatId, title: 'Doc: ' + file.name, messages: [tempUserMsg] }, ...prev];
      }
      const newChats = [...prev];
      newChats[chatIndex].messages.push(tempUserMsg);
      return newChats;
    });

    try {
      const activeKey = provider === 'claude' ? claudeKey : provider === 'chatgpt' ? openaiKey : provider === 'copilot' ? copilotKey : geminiKey;
      const headers = { 
        'Content-Type': 'application/json',
        'x-provider': provider
      };
      if (activeKey) headers['x-api-key'] = activeKey;

      const res = await fetch(`${BACKEND_URL}/user-stories/generate-from-doc`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          documentName: file.name,
          documentText: file.text,
          positiveCount,
          negativeCount,
          edgeCount,
          securityCount,
          performanceCount,
          customizeVolume,
          userId,
          chatId: currentChatId,
          format
        })
      });

      if (res.ok) {
        const data = await res.json();
        setDuplicateCount(data.duplicateCount || 0);
        setTestCases(data.testCases || []);
        
        // Auto-fill input fields
        setUserStory(data.userStory || '');
        setAcceptanceCriteria(data.acceptanceCriteria || '');

        setActiveStory(data.story || {
          id: data.storyId,
          title: data.userStory.substring(0, 50) || 'Story from ' + file.name,
          description: data.userStory,
          userId
        });

        // Clear uploaded files & context
        setUploadedFiles([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }

        // Refresh lists
        await fetchChats();
        await fetchPastStories();

        // Route immediately to repository tab
        setActiveTab('repository');
      }
    } catch (err) {
      console.error('Failed to generate from document:', err);
      // Clean up temp message on failure
      setChats(prev => prev.map(c =>
        c.id === currentChatId
          ? { ...c, messages: c.messages.filter(m => m.id !== tempId) }
          : c
      ));
    } finally {
      setIsTyping(false);
    }
  };

  // --- Send follow-up chat message ---
  const handleSendChatMessage = async () => {
    if (!chatInput.trim() || isTyping) return;
    let currentChatId = activeChatId;
    if (!currentChatId) {
      currentChatId = generateChatId();
      setActiveChatId(currentChatId);
    }

    const content = chatInput;
    const tempId = 'temp-' + Date.now();
    setChatInput('');
    setIsTyping(true);

    // Optimistically add user message so it shows immediately
    setChats(prev => {
      const chatIndex = prev.findIndex(c => c.id === currentChatId);
      const tempUserMsg = { id: tempId, role: 'user', content };
      if (chatIndex === -1) {
        return [{ id: currentChatId, title: content.substring(0, 20), messages: [tempUserMsg] }, ...prev];
      }
      const newChats = [...prev];
      newChats[chatIndex] = {
        ...newChats[chatIndex],
        messages: [...newChats[chatIndex].messages, tempUserMsg]
      };
      return newChats;
    });

    try {
      const activeKey = provider === 'claude' ? claudeKey : provider === 'chatgpt' ? openaiKey : provider === 'copilot' ? copilotKey : geminiKey;
      const headers = { 
        'Content-Type': 'application/json',
        'x-provider': provider,
        'x-format': format
      };
      if (activeKey) headers['x-api-key'] = activeKey;

      const res = await fetch(`${BACKEND_URL}/chats/${currentChatId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          role: 'user',
          content,
          title: content.substring(0, 25),
          userId
        })
      });

      if (res.ok) {
        const data = await res.json();
        // Replace temp message with actual user/AI messages from the response
        setChats(prev => prev.map(c =>
          c.id === currentChatId
            ? {
                ...c,
                messages: [
                  ...c.messages.filter(m => m.id !== tempId),
                  data.userMessage,
                  data.aiMessage
                ]
              }
            : c
        ));
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      // Remove temp message on failure
      setChats(prev => prev.map(c =>
        c.id === currentChatId
          ? { ...c, messages: c.messages.filter(m => m.id !== tempId) }
          : c
      ));
    } finally {
      setIsTyping(false);
    }
  };


  const deleteChat = async (e, chatId) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this chat session?')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, { method: 'DELETE' });
      if (res.ok) {
        setChats(prev => {
          const updated = prev.filter(c => c.id !== chatId);
          if (activeChatId === chatId) {
            setActiveChatId(updated.length > 0 ? updated[0].id : null);
          }
          return updated;
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- Test Case In-place Editing & CRUD ---
  const handleEditClick = (tc) => {
    setEditingTcId(tc.id);
    setEditingTcData({ ...tc, format: format });
  };

  const handleEditSave = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/test-cases/${editingTcId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingTcData)
      });
      if (res.ok) {
        const updated = await res.json();
        setTestCases(prev => prev.map(tc => tc.id === editingTcId ? updated : tc));
        setEditingTcId(null);
        if (activeStory) {
          fetchPastStories();
        }
      }
    } catch (err) {
      console.error('Failed to update test case:', err);
    }
  };

  const handleDeleteTestCase = async (id) => {
    if (!confirm('Are you sure you want to delete this test case?')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/test-cases/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setTestCases(prev => prev.filter(tc => tc.id !== id));
        fetchPastStories();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- Retrieve past user story test cases ---
  const handleLoadPastStory = async (story) => {
    setActiveStory(story);
    setDuplicateCount(0);
    try {
      const res = await fetch(`${BACKEND_URL}/user-stories/${story.id}/test-cases`);
      const data = await res.json();
      setTestCases(data);
      if (story.chatId) {
        setActiveChatId(story.chatId);
      }
      setActiveTab('repository');
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeletePastStory = async (e, storyId) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this User Story and its test cases?')) return;
    try {
      const res = await fetch(`${BACKEND_URL}/user-stories/${storyId}`, { method: 'DELETE' });
      if (res.ok) {
        setPastStories(prev => prev.filter(s => s.id !== storyId));
        if (activeStory?.id === storyId) {
          setActiveStory(null);
          setTestCases([]);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- QAtlas Advanced QA Workflows (BDD, Dry-Run, Exporters) ---
  const toggleBddMode = (tcId) => {
    setBddModes(prev => ({ ...prev, [tcId]: !prev[tcId] }));
  };

  const convertToGherkin = (tc) => {
    const cleanPre = tc.preconditions && tc.preconditions !== 'N/A'
      ? tc.preconditions.replace(/^\[AC\d+\]\s*/i, '').trim()
      : '';
    
    let gherkinLines = [];
    if (cleanPre) {
      const preLines = cleanPre.split(/(?:\. |\n)/).map(s => s.trim()).filter(Boolean);
      preLines.forEach((line, idx) => {
        const prefix = idx === 0 ? 'Given ' : 'And ';
        const cleaned = line.replace(/^(given|and|when|then)\s+/i, '');
        gherkinLines.push(`${prefix}${cleaned}`);
      });
    } else {
      gherkinLines.push('Given the system is in default state');
    }

    const rawSteps = tc.steps || '';
    const parsedSteps = rawSteps.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^\d+[\.\)\s-]+\s*/, '')); // remove step numbers

    let currentSection = 'When';
    let hasWhen = false;
    let hasThen = false;

    const actionVerbs = /^(click|select|enter|fill|type|submit|press|navigate|open|go to|choose|drag|drop|hover|perform|run|execute|trigger|request|send|post|get|put|delete|patch)/i;
    const verifyVerbs = /^(verify|check|ensure|assert|validate|confirm|see|should|is shown|is displayed|appears|is visible|observe|witness|must)/i;
    const givenVerbs = /^(given|setup|assume|authorized|logged in|user is)/i;

    parsedSteps.forEach((step) => {
      let verbPrefix = '';
      let cleanedStep = step;
      
      const bddMatch = step.match(/^(given|when|then|and|but)\s+/i);
      if (bddMatch) {
        verbPrefix = bddMatch[1].toLowerCase();
        verbPrefix = verbPrefix.charAt(0).toUpperCase() + verbPrefix.slice(1);
        cleanedStep = step.replace(/^(given|when|then|and|but)\s+/i, '');
      }

      if (!verbPrefix) {
        if (givenVerbs.test(step)) {
          if (!hasWhen && !hasThen) {
            verbPrefix = gherkinLines.length === 1 && gherkinLines[0] === 'Given the system is in default state' ? 'Given' : 'And';
            if (verbPrefix === 'Given') {
              gherkinLines = []; // clear default state
            }
            currentSection = 'Given';
          } else {
            verbPrefix = 'And';
          }
        } else if (verifyVerbs.test(step)) {
          if (currentSection === 'Then') {
            verbPrefix = 'And';
          } else {
            verbPrefix = 'Then';
            currentSection = 'Then';
            hasThen = true;
          }
        } else {
          // Default to action (When)
          if (currentSection === 'When') {
            verbPrefix = hasWhen ? 'And' : 'When';
            hasWhen = true;
          } else if (currentSection === 'Given') {
            verbPrefix = 'When';
            currentSection = 'When';
            hasWhen = true;
          } else {
            verbPrefix = 'When';
            currentSection = 'When';
            hasWhen = true;
          }
        }
      } else {
        if (verbPrefix === 'Given') currentSection = 'Given';
        if (verbPrefix === 'When') { currentSection = 'When'; hasWhen = true; }
        if (verbPrefix === 'Then') { currentSection = 'Then'; hasThen = true; }
      }

      gherkinLines.push(`${verbPrefix} ${cleanedStep}`);
    });

    if (tc.expectedResult && tc.expectedResult !== 'N/A') {
      const cleanExpected = tc.expectedResult.replace(/^(then|and|but)\s+/i, '').trim();
      const expectedLines = cleanExpected.split(/(?:\. |\n)/).map(s => s.trim()).filter(Boolean);
      expectedLines.forEach((line, idx) => {
        let prefix = '';
        if (idx === 0) {
          prefix = currentSection === 'Then' ? 'And ' : 'Then ';
          currentSection = 'Then';
        } else {
          prefix = 'And ';
        }
        gherkinLines.push(`${prefix}${line}`);
      });
    }

    return `Scenario: ${tc.title}\n  ${gherkinLines.join('\n  ')}`;
  };

  const convertToPlaywright = (tc) => {
    const titleClean = tc.title ? tc.title.replace(/"/g, '\\"') : 'Test Case';
    const idClean = tc.customId || tc.id;
    const stepsList = tc.steps ? tc.steps.split('\n').filter(s => s.trim().length > 0) : [];
    
    let jsLines = [];
    jsLines.push(`import { test, expect } from '@playwright/test';\n`);
    jsLines.push(`test('${idClean}: ${titleClean}', async ({ page }) => {`);
    
    if (tc.preconditions && tc.preconditions !== 'N/A') {
      jsLines.push(`  // Preconditions: ${tc.preconditions.replace(/\n/g, ' ')}`);
    }
    
    stepsList.forEach((step, idx) => {
      const cleanStep = step.replace(/^\d+[\.\)\s-]+\s*/, '').trim();
      jsLines.push(`  // Step ${idx + 1}: ${cleanStep}`);
      
      const lowerStep = cleanStep.toLowerCase();
      if (lowerStep.includes('click') || lowerStep.includes('tap') || lowerStep.includes('press')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const target = match ? match[1] : 'button';
        jsLines.push(`  await page.click('text="${target}"');`);
      } else if (lowerStep.includes('enter') || lowerStep.includes('type') || lowerStep.includes('fill')) {
        const matchText = cleanStep.match(/['"]([^'"]+)['"]/g);
        const value = matchText && matchText[0] ? matchText[0].replace(/['"]/g, '') : 'test data';
        const field = matchText && matchText[1] ? matchText[1].replace(/['"]/g, '') : 'input';
        jsLines.push(`  await page.fill('input[placeholder*="${field}"], input[name="${field}"], label:has-text("${field}") ~ input', '${value}');`);
      } else if (lowerStep.includes('select') || lowerStep.includes('choose')) {
        const matchText = cleanStep.match(/['"]([^'"]+)['"]/g);
        const option = matchText && matchText[0] ? matchText[0].replace(/['"]/g, '') : '';
        const field = matchText && matchText[1] ? matchText[1].replace(/['"]/g, '') : 'select';
        if (option) {
          jsLines.push(`  await page.selectOption('select[name="${field}"], label:has-text("${field}") ~ select', { label: '${option}' });`);
        } else {
          jsLines.push(`  // TODO: Implement select option`);
        }
      } else if (lowerStep.includes('navigate') || lowerStep.includes('open') || lowerStep.includes('go to')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const url = match ? match[1] : '/';
        jsLines.push(`  await page.goto('${url.startsWith('http') ? url : url}');`);
      } else if (lowerStep.includes('verify') || lowerStep.includes('check') || lowerStep.includes('should') || lowerStep.includes('expect')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const text = match ? match[1] : 'expected text';
        jsLines.push(`  await expect(page.locator('body')).toContainText('${text}');`);
      } else {
        jsLines.push(`  // Action: ${cleanStep}`);
      }
      jsLines.push('');
    });
    
    if (tc.expectedResult) {
      jsLines.push(`  // Assert Expected Result: ${tc.expectedResult.replace(/\n/g, ' ')}`);
      const match = tc.expectedResult.match(/['"]([^'"]+)['"]/);
      const assertText = match ? match[1] : '';
      if (assertText) {
        jsLines.push(`  await expect(page.locator('body')).toContainText('${assertText}');`);
      }
    }
    
    jsLines.push(`});`);
    return jsLines.join('\n');
  };

  const convertToCypress = (tc) => {
    const titleClean = tc.title ? tc.title.replace(/"/g, '\\"') : 'Test Case';
    const idClean = tc.customId || tc.id;
    const stepsList = tc.steps ? tc.steps.split('\n').filter(s => s.trim().length > 0) : [];
    
    let jsLines = [];
    jsLines.push(`describe('${idClean}: ${titleClean}', () => {`);
    jsLines.push(`  it('should execute successfully', () => {`);
    
    if (tc.preconditions && tc.preconditions !== 'N/A') {
      jsLines.push(`    // Preconditions: ${tc.preconditions.replace(/\n/g, ' ')}`);
    }
    
    stepsList.forEach((step, idx) => {
      const cleanStep = step.replace(/^\d+[\.\)\s-]+\s*/, '').trim();
      jsLines.push(`    // Step ${idx + 1}: ${cleanStep}`);
      
      const lowerStep = cleanStep.toLowerCase();
      if (lowerStep.includes('click') || lowerStep.includes('tap') || lowerStep.includes('press')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const target = match ? match[1] : 'button';
        jsLines.push(`    cy.contains('${target}').click();`);
      } else if (lowerStep.includes('enter') || lowerStep.includes('type') || lowerStep.includes('fill')) {
        const matchText = cleanStep.match(/['"]([^'"]+)['"]/g);
        const value = matchText && matchText[0] ? matchText[0].replace(/['"]/g, '') : 'test data';
        const field = matchText && matchText[1] ? matchText[1].replace(/['"]/g, '') : 'input';
        jsLines.push(`    cy.get('input[placeholder*="${field}"], input[name="${field}"]')\n      .clear().type('${value}');`);
      } else if (lowerStep.includes('select') || lowerStep.includes('choose')) {
        const matchText = cleanStep.match(/['"]([^'"]+)['"]/g);
        const option = matchText && matchText[0] ? matchText[0].replace(/['"]/g, '') : '';
        const field = matchText && matchText[1] ? matchText[1].replace(/['"]/g, '') : 'select';
        if (option) {
          jsLines.push(`    cy.get('select[name="${field}"]').select('${option}');`);
        } else {
          jsLines.push(`    // TODO: Implement select option`);
        }
      } else if (lowerStep.includes('navigate') || lowerStep.includes('open') || lowerStep.includes('go to')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const url = match ? match[1] : '/';
        jsLines.push(`    cy.visit('${url.startsWith('http') ? url : url}');`);
      } else if (lowerStep.includes('verify') || lowerStep.includes('check') || lowerStep.includes('should') || lowerStep.includes('expect')) {
        const match = cleanStep.match(/['"]([^'"]+)['"]/);
        const text = match ? match[1] : 'expected text';
        jsLines.push(`    cy.contains('${text}').should('be.visible');`);
      } else {
        jsLines.push(`    // Action: ${cleanStep}`);
      }
      jsLines.push('');
    });
    
    if (tc.expectedResult) {
      jsLines.push(`    // Assert Expected Result: ${tc.expectedResult.replace(/\n/g, ' ')}`);
      const match = tc.expectedResult.match(/['"]([^'"]+)['"]/);
      const assertText = match ? match[1] : '';
      if (assertText) {
        jsLines.push(`    cy.contains('${assertText}').should('be.visible');`);
      }
    }
    
    jsLines.push(`  });`);
    jsLines.push(`});`);
    return jsLines.join('\n');
  };

  const startDryRun = () => {
    if (testCases.length === 0) return;
    setDryRunCases(testCases);
    setCurrentDryRunIndex(0);
    setDryRunStepChecks({});
    setDryRunComments('');
  };

  const handleDryRunSaveStatus = async (status) => {
    const currentCase = dryRunCases[currentDryRunIndex];
    if (!currentCase) return;

    try {
      const res = await fetch(`${BACKEND_URL}/test-cases/${currentCase.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...currentCase,
          executionStatus: status,
          executionComments: dryRunComments
        })
      });

      if (res.ok) {
        const updated = await res.json();
        // Update local testCases array
        setTestCases(prev => prev.map(tc => tc.id === currentCase.id ? updated : tc));
        // Update local dryRunCases array
        setDryRunCases(prev => prev.map(tc => tc.id === currentCase.id ? updated : tc));
      }
    } catch (err) {
      console.error('Failed to update execution status:', err);
    }

    // Reset details and advance index
    setDryRunComments('');
    setDryRunStepChecks({});
    setCurrentDryRunIndex(prev => prev + 1);
  };

  const getJiraMarkdown = () => {
    if (format === 'LLY TU') {
      let md = `||Test Case ID||Test Path||Type||Test Name||Designer||Category||Description||Step Name||Step Description||Expected Result||Evidence Required||Status||\n`;
      testCases.forEach(tc => {
        const id = tc.customId || tc.id;
        const path = getCustomField(tc, 'testPath');
        const type = tc.type || 'Positive';
        const name = tc.title || 'Generated Scenario';
        const designer = getCustomField(tc, 'designer');
        const cat = getCustomField(tc, 'category');
        const desc = getCustomField(tc, 'description');
        const sName = getCustomField(tc, 'stepName');
        const sDesc = (tc.steps || '').replace(/\n/g, '\\\\ ');
        const expected = (tc.expectedResult || '').replace(/\n/g, '\\\\ ');
        const evidence = getCustomField(tc, 'evidenceRequired');
        const status = tc.executionStatus || 'Pending';
        md += `|${id}|${path}|${type}|${name}|${designer}|${cat}|${desc}|${sName}|${sDesc}|${expected}|${evidence}|${status}|\n`;
      });
      return md;
    } else if (format === 'LLY PBPA') {
      let md = `||Test Case ID||Test Summary||Test Case Description||Steps to be Followed||Expected Result||Actual Result||Status||\n`;
      testCases.forEach(tc => {
        const id = tc.customId || tc.id;
        const summary = tc.title || 'Generated Scenario';
        const desc = getCustomField(tc, 'testCaseDescription');
        const steps = (tc.steps || '').replace(/\n/g, '\\\\ ');
        const expected = (tc.expectedResult || '').replace(/\n/g, '\\\\ ');
        const actual = getCustomField(tc, 'actualResult');
        const status = tc.executionStatus || 'Pending';
        md += `|${id}|${summary}|${desc}|${steps}|${expected}|${actual}|${status}|\n`;
      });
      return md;
    } else if (format === 'DEL') {
      let md = `||Test Case Id||Description||Test Data||Test Steps||Expected Result||Actual Result||Status||Bug ID||\n`;
      testCases.forEach(tc => {
        const id = tc.customId || tc.id;
        const desc = tc.title || 'Generated Scenario';
        const data = getCustomField(tc, 'testData');
        const steps = (tc.steps || '').replace(/\n/g, '\\\\ ');
        const expected = (tc.expectedResult || '').replace(/\n/g, '\\\\ ');
        const actual = getCustomField(tc, 'actualResult');
        const status = tc.executionStatus || 'Pending';
        const bug = getCustomField(tc, 'bugId');
        md += `|${id}|${desc}|${data}|${steps}|${expected}|${actual}|${status}|${bug}|\n`;
      });
      return md;
    } else {
      let md = `||Test Case ID||Type||Title||Description||Preconditions||Steps||Expected Result||Priority||Status||\n`;
      testCases.forEach(tc => {
        const desc = getCustomField(tc, 'description') || 'N/A';
        const preconditions = tc.preconditions || 'N/A';
        const steps = (tc.steps || '').replace(/\n/g, '\\\\ ');
        const expected = (tc.expectedResult || '').replace(/\n/g, '\\\\ ');
        const status = tc.executionStatus || 'Pending';
        md += `|${tc.customId || tc.id}|${tc.type}|${tc.title}|${desc}|${preconditions}|${steps}|${expected}|${tc.priority}|${status}|\n`;
      });
      return md;
    }
  };


  // --- Settings Actions ---
  const handleSaveSettings = () => {
    const trimmedGemini = (tempGeminiKey || '').trim();
    const trimmedClaude = (tempClaudeKey || '').trim();
    const trimmedOpenai = (tempOpenaiKey || '').trim();
    const trimmedCopilot = (tempCopilotKey || '').trim();

    setUserId(tempUserId);
    setProvider(tempProvider);
    setGeminiKey(trimmedGemini);
    setClaudeKey(trimmedClaude);
    setOpenaiKey(trimmedOpenai);
    setCopilotKey(trimmedCopilot);
    localStorage.setItem('qatlas_userId', tempUserId);
    localStorage.setItem('qatlas_provider', tempProvider);
    localStorage.setItem('qatlas_geminiKey', trimmedGemini);
    localStorage.setItem('qatlas_claudeKey', trimmedClaude);
    localStorage.setItem('qatlas_openaiKey', trimmedOpenai);
    localStorage.setItem('qatlas_copilotKey', trimmedCopilot);
    setIsSettingsOpen(false);
    createNewChat(); // Reset environment for new user segregation
  };

  // --- File Imports (JSON/CSV) ---
  const handleFileImport = (e) => {
    const file = e.target.files[0];
    if (!file || !activeStory) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const fileText = evt.target.result;
      let importedCases = [];
      try {
        if (file.name.endsWith('.json')) {
          importedCases = parseJSON(fileText);
        } else if (file.name.endsWith('.csv')) {
          importedCases = parseCSV(fileText);
        } else {
          alert('Unsupported file format. Please upload .json or .csv');
          return;
        }

        // Send to backend
        const res = await fetch(`${BACKEND_URL}/user-stories/${activeStory.id}/import-test-cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testCases: importedCases })
        });
        if (res.ok) {
          const resData = await res.json();
          setTestCases(prev => [...prev, ...resData.testCases]);
          alert(`Successfully imported ${resData.count} test cases!`);
          fetchPastStories();
        }
      } catch (err) {
        alert('Failed to parse file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const parseCSV = (text) => {
    const lines = text.split('\n');
    const result = [];
    if (lines.length < 2) return [];
    
    // Simple CSV parser
    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values = [];
      let inQuotes = false;
      let currentVal = '';
      
      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        const char = line[charIndex];
        if (char === '"' || char === "'") {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(currentVal.trim().replace(/^["']|["']$/g, ''));
          currentVal = '';
        } else {
          currentVal += char;
        }
      }
      values.push(currentVal.trim().replace(/^["']|["']$/g, ''));
      
      const row = {};
      headers.forEach((header, index) => {
        row[header.toLowerCase()] = values[index] || '';
      });
      
      result.push({
        title: row.title || row.name || 'Imported Test Case',
        type: row.type || 'Positive',
        preconditions: row.preconditions || row.precondition || 'N/A',
        steps: (row.steps || row.step || '1. Open action page.').replace(/\\n/g, '\n'),
        expectedResult: row.expectedresult || row.expected || 'Success.',
        priority: row.priority || 'Medium'
      });
    }
    return result;
  };

  const parseJSON = (text) => {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.testCases || [data]);
    return list.map(tc => ({
      title: tc.title || tc.name || 'Imported Test Case',
      type: tc.type || 'Positive',
      preconditions: tc.preconditions || tc.precondition || 'N/A',
      steps: Array.isArray(tc.steps) ? tc.steps.join('\n') : (tc.steps || '1. Open system.'),
      expectedResult: tc.expectedResult || tc.expected || 'Success.',
      priority: tc.priority || 'Medium'
    }));
  };

  // --- Export File ---
  const handleExport = (exportType) => {
    if (testCases.length === 0) return;
    let content = '';
    let mimeType = 'text/plain';
    let filename = `QAtlas_TestCases_${activeStory?.id || 'export'}`;

    if (exportType === 'json') {
      content = JSON.stringify(testCases, null, 2);
      mimeType = 'application/json';
      filename += '.json';
    } else {
      // Export as CSV
      let headers = [];
      let rows = [];

      if (format === 'LLY TU') {
        headers = ['Test Case ID', 'Test Path', 'Type', 'Test Name', 'Designer', 'Category', 'Description', 'Preconditions', 'Step Name', 'Step Description', 'Expected Result', 'Evidence Required', 'Status'];
        rows = testCases.map(tc => [
          tc.customId || tc.id,
          `"${(getCustomField(tc, 'testPath') || '/DefaultPath/Section').replace(/"/g, '""')}"`,
          tc.type || 'Positive',
          `"${(tc.title || 'Generated Scenario').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'designer') || 'QA Team').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'category') || 'General').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'description') || tc.title || '').replace(/"/g, '""')}"`,
          `"${(tc.preconditions || 'N/A').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'stepName') || 'Perform Action').replace(/"/g, '""')}"`,
          `"${(tc.steps || '').replace(/\n/g, '\\n').replace(/"/g, '""')}"`,
          `"${(tc.expectedResult || '').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'evidenceRequired') || 'No').replace(/"/g, '""')}"`,
          tc.executionStatus || 'Pending'
        ]);
      } else if (format === 'LLY PBPA') {
        headers = ['Test Case ID', 'Test Summary', 'Test Case Description', 'Preconditions', 'Steps to be Followed', 'Expected Result', 'Actual Result', 'Status'];
        rows = testCases.map(tc => [
          tc.customId || tc.id,
          `"${(tc.title || 'Generated Scenario').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'testCaseDescription') || getCustomField(tc, 'description') || tc.title || '').replace(/"/g, '""')}"`,
          `"${(tc.preconditions || 'N/A').replace(/"/g, '""')}"`,
          `"${(tc.steps || '').replace(/\n/g, '\\n').replace(/"/g, '""')}"`,
          `"${(tc.expectedResult || '').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'actualResult') || 'N/A').replace(/"/g, '""')}"`,
          tc.executionStatus || 'Pending'
        ]);
      } else if (format === 'DEL') {
        headers = ['Test Case Id', 'Description', 'Type', 'Preconditions', 'Test Data', 'Test Steps', 'Expected Result', 'Actual Result', 'Status', 'Bug ID'];
        rows = testCases.map(tc => [
          tc.customId || tc.id,
          `"${(tc.title || 'Generated Scenario').replace(/"/g, '""')}"`,
          tc.type || 'Positive',
          `"${(tc.preconditions || 'N/A').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'testData') || 'Valid credentials').replace(/"/g, '""')}"`,
          `"${(tc.steps || '').replace(/\n/g, '\\n').replace(/"/g, '""')}"`,
          `"${(tc.expectedResult || '').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'actualResult') || 'N/A').replace(/"/g, '""')}"`,
          tc.executionStatus || 'Pending',
          `"${(getCustomField(tc, 'bugId') || 'N/A').replace(/"/g, '""')}"`
        ]);
      } else {
        headers = ['Test Case ID', 'Type', 'Title', 'Description', 'Preconditions', 'Steps', 'Expected Result', 'Priority', 'Status'];
        rows = testCases.map(tc => [
          tc.customId || tc.id,
          tc.type,
          `"${(tc.title || '').replace(/"/g, '""')}"`,
          `"${(getCustomField(tc, 'description') || tc.title || 'Verify the scenario.').replace(/"/g, '""')}"`,
          `"${(tc.preconditions || 'N/A').replace(/"/g, '""')}"`,
          `"${(tc.steps || '').replace(/\n/g, '\\n').replace(/"/g, '""')}"`,
          `"${(tc.expectedResult || '').replace(/"/g, '""')}"`,
          tc.priority || 'Medium',
          tc.executionStatus || 'Pending'
        ]);
      }

      content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      mimeType = 'text/csv';
      filename += '.csv';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const activeChat = chats.find(c => c.id === activeChatId) || { messages: [] };

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeChat.messages, isTyping]);

  const NumberInput = ({ label, value, setter }) => (
    <div className="number-input-group">
      <label>{label}</label>
      <div className="number-controls">
        <button onClick={() => setter(Math.max(0, value - 1))}>−</button>
        <span className="value-display">{value}</span>
        <button onClick={() => setter(value + 1)}>+</button>
      </div>
    </div>
  );

  return (
    <div className="qatlas-container">
      {/* Sidebar Overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      
      {/* Sidebar */}
      <div className={`qatlas-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">Q</div>
          <span>QAtlas Console</span>
        </div>

        {/* UPLOAD DOCUMENTS */}
        <div className="sidebar-section">
          <label className="sidebar-label">Upload Documents</label>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            multiple
            accept=".pdf,.docx,.txt,.md,.csv,.json,.js,.ts,.jsx,.tsx,.py,.java"
            onChange={onFileInputChange}
          />
          <div
            className={`upload-box ${isDragging ? 'dragging' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
          >
            {isUploading ? (
              <span>Extracting Context…</span>
            ) : (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>Upload or drag & drop</span>
              </>
            )}
          </div>
          <span className="upload-hint">Upload docs to provide context for test case accuracy</span>
        </div>

        {/* Uploaded files display list */}
        {uploadedFiles.length > 0 && (
          <div className="uploaded-file-list">
            {uploadedFiles.map((f, idx) => (
              <div key={idx} className="uploaded-file-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="file-name" title={f.name} style={{ fontSize: '11px', fontWeight: '500' }}>📎 {f.name}</span>
                  <button className="file-remove-btn" onClick={() => removeFile(idx)} style={{ fontSize: '10px' }}>✕</button>
                </div>
                
                <div style={{ display: 'flex', gap: '4px', flexDirection: 'column', margin: '2px 0' }}>
                  <select
                    className="sidebar-select"
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    style={{ padding: '4px 6px', fontSize: '11px', background: '#ffffff', border: '1px solid var(--border-color)', borderRadius: '6px', color: '#000000', width: '100%', cursor: 'pointer', outline: 'none' }}
                  >
                    <option value="Default" style={{ color: '#000000', background: '#ffffff' }}>Default format</option>
                    <option value="LLY TU" style={{ color: '#000000', background: '#ffffff' }}>LLY TU</option>
                    <option value="LLY PBPA" style={{ color: '#000000', background: '#ffffff' }}>LLY PBPA</option>
                    <option value="DEL" style={{ color: '#000000', background: '#ffffff' }}>DEL</option>
                  </select>
                </div>

                <button 
                  className="new-session-btn" 
                  onClick={() => handleGenerateFromDoc(f)} 
                  disabled={isTyping}
                  style={{ padding: '6px 12px', fontSize: '11.5px', background: 'linear-gradient(135deg, var(--primary), var(--accent))', border: 'none', borderRadius: '6px', color: '#ffffff', fontWeight: '600', cursor: 'pointer', boxShadow: '0 2px 8px var(--primary-glow)', width: '100%', marginTop: '4px' }}
                >
                  {isTyping ? 'Generating...' : '✨ Generate Test Cases'}
                </button>
              </div>
            ))}
          </div>
        )}

        <hr className="sidebar-divider" />

        <div className="sidebar-header-flex">
          <label className="sidebar-label" style={{ margin: 0 }}>Chats History</label>
          <button className="new-session-btn" onClick={createNewChat}>+ New Session</button>
        </div>

        <div className="chat-history-list">
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`history-item ${activeChatId === chat.id ? 'active' : ''}`}
              onClick={() => { setActiveChatId(chat.id); setSidebarOpen(false); }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>💬 {chat.title}</span>
              <button className="delete-history-btn" onClick={(e) => deleteChat(e, chat.id)}>✕</button>
            </div>
          ))}
        </div>

        {/* Settings Bar */}
        <div className="sidebar-settings" style={{ display: 'flex', gap: '8px' }}>
          <button className="settings-btn" onClick={() => {
            setTempUserId(userId);
            setTempProvider(provider);
            setTempGeminiKey(geminiKey);
            setTempClaudeKey(claudeKey);
            setTempOpenaiKey(openaiKey);
            setTempCopilotKey(copilotKey);
            setIsSettingsOpen(true);
          }} style={{ flexGrow: 1 }}>
            ⚙️ Settings ({userId})
          </button>
          <button className="settings-btn" onClick={toggleTheme} style={{ width: '45px', padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Toggle light/dark theme">
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </div>

      {/* Main Area */}
      <div className="qatlas-main">
        {/* Mobile Header */}
        <div className="mobile-header">
          <button className="sidebar-toggle-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <span className="mobile-logo-text">QAtlas Console</span>
        </div>

        {/* Navigation Tabs */}
        <div className="tabs-navigation">
          <button className={`tab-btn ${activeTab === 'generator' ? 'active' : ''}`} onClick={() => setActiveTab('generator')}>
            AI Generator & Chat
          </button>
          <button className={`tab-btn ${activeTab === 'repository' ? 'active' : ''}`} onClick={() => setActiveTab('repository')}>
            Test Cases Repository ({testCases.length})
          </button>
          <button className={`tab-btn ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
            QA Analytics & Coverage
          </button>
          <button className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
            History Dashboard
          </button>
        </div>

        {/* Tab 1: AI Generator & Chat */}
        {activeTab === 'generator' && (
          <div className="tab-content" style={{ flexDirection: 'row' }}>
            <div className="generator-row">
              {/* Form Input Panel */}
              <div className="generator-form-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h1 className="qatlas-title">QAtlas test case generator</h1>
                  {activeStory && (
                    <span style={{ fontSize: '12px', color: 'var(--primary)' }}>
                      Active: {activeStory.id}
                    </span>
                  )}
                </div>

                <div className="form-group">
                  <label>User Story</label>
                  <textarea
                    placeholder="As a [user type], I want to [perform action] so that [business goal]..."
                    value={userStory}
                    onChange={(e) => setUserStory(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Acceptance Criteria</label>
                  <textarea
                    placeholder="AC1: System validation rule...\nAC2: Success condition...\nAC3: Dynamic validation flow..."
                    value={acceptanceCriteria}
                    onChange={(e) => setAcceptanceCriteria(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label>Test Case Format</label>
                  <select
                    className="sidebar-select"
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    style={{ width: '100%', padding: '10px', background: 'var(--bg-sidebar)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-main)', fontSize: '13px' }}
                  >
                    <option value="Default">Default format</option>
                    <option value="LLY TU">LLY TU</option>
                    <option value="LLY PBPA">LLY PBPA</option>
                    <option value="DEL">DEL</option>
                  </select>
                </div>

                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ margin: 0 }}>Test Case Volume Selection</label>
                    <label className="switch-container" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', textTransform: 'none', fontSize: '12px', fontWeight: '600', color: 'var(--primary)' }}>
                      <input
                        type="checkbox"
                        checked={customizeVolume}
                        onChange={(e) => setCustomizeVolume(e.target.checked)}
                        style={{ cursor: 'pointer', width: '14px', height: '14px' }}
                      />
                      Customize Counts
                    </label>
                  </div>
                  {customizeVolume ? (
                    <div className="counts-row">
                      <NumberInput label="Positive ✅" value={positiveCount} setter={setPositiveCount} />
                      <NumberInput label="Negative ❌" value={negativeCount} setter={setNegativeCount} />
                      <NumberInput label="Edge ⚠️" value={edgeCount} setter={setEdgeCount} />
                      <NumberInput label="Security 🔒" value={securityCount} setter={setSecurityCount} />
                      <NumberInput label="Performance ⚡" value={performanceCount} setter={setPerformanceCount} />
                    </div>
                  ) : (
                    <div style={{ padding: '12px', background: 'var(--bg-glass-hover)', border: '1px dashed var(--border-color)', borderRadius: '10px', fontSize: '12.5px', color: 'var(--text-sub)', lineHeight: '1.4' }}>
                      ℹ️ AI will dynamically determine the optimal number of test cases required to cover the requirements without redundancy.
                    </div>
                  )}
                </div>

                <button
                  className="generate-btn"
                  onClick={handleGenerateTestCases}
                  disabled={isTyping || (!userStory.trim() && !acceptanceCriteria.trim())}
                >
                  {isTyping ? 'Generating Test Cases...' : '✨ Generate Test Suite'}
                </button>
              </div>

              {/* Chat Panel */}
              <div className="generator-chat-panel">
                <div className="chat-header">
                  <span>QAtlas Discussion Log</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-sub)' }}>
                    {(provider === 'claude' ? claudeKey : provider === 'chatgpt' ? openaiKey : provider === 'copilot' ? copilotKey : geminiKey) 
                      ? `⚡ ${provider === 'claude' ? 'Claude Opus 4.8' : provider === 'chatgpt' ? 'ChatGPT (GPT-5.5)' : provider === 'copilot' ? 'Microsoft Copilot' : 'Gemini 3.5 Flash'} Connected` 
                      : 'Mock offline mode'}
                  </span>
                </div>
                <div className="chat-messages">
                  {activeChat.messages.length === 0 ? (
                    <div className="empty-state" style={{ border: 'none', margin: 'auto' }}>
                      <h3>Interactive QAtlas Chat</h3>
                      <p>Ask follow-up questions to refine, tweak, or add test cases. All discussion history is saved in SQLite.</p>
                    </div>
                  ) : (
                    activeChat.messages.map((msg, idx) => (
                      <div key={idx} className={`message-row ${msg.role}`}>
                        <div className={`message-bubble ${msg.role}`}>
                          {msg.content.split('\n').map((line, i) => (
                            <p key={i}>{line}</p>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                  {isTyping && (
                    <div className="message-row ai">
                      <div className="message-bubble ai typing">
                        <span className="dot"></span><span className="dot"></span><span className="dot"></span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
                <div className="chat-input-area">
                  <input
                    type="text"
                    placeholder="Tweak output, ask follow-up questions..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendChatMessage()}
                    disabled={isTyping}
                  />
                  <button onClick={handleSendChatMessage} disabled={!chatInput.trim() || isTyping}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Test Case Repository */}
        {activeTab === 'repository' && (
          <div className="tab-content">
            <div className="repo-header">
              <div className="repo-title-section">
                <h2 style={{ fontFamily: 'Outfit, sans-serif' }}>
                  {activeStory ? `Test Cases: ${activeStory.title}` : 'Test Case Repository'}
                </h2>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
                  <span className="repo-subtitle">
                    Viewing {testCases.length} saved scenarios for user: <strong>{userId}</strong>
                  </span>
                  {duplicateCount > 0 && (
                    <span style={{ color: 'var(--security-color)', fontSize: '12px', background: 'rgba(245,158,11,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                      ⚠️ Filtered out {duplicateCount} duplicates
                    </span>
                  )}
                </div>
              </div>

              <div className="repo-actions">
                {activeStory && (
                  <>
                    <input
                      type="file"
                      ref={importInputRef}
                      style={{ display: 'none' }}
                      accept=".json,.csv"
                      onChange={handleFileImport}
                    />
                    <button className="btn-secondary" onClick={() => importInputRef.current?.click()}>
                      📥 Import (.JSON/.CSV)
                    </button>
                    <button className="btn-secondary" onClick={() => handleExport('json')}>
                      📤 Export JSON
                    </button>
                    <button className="btn-secondary" onClick={() => handleExport('csv')}>
                      📊 Export CSV
                    </button>
                    <button className="btn-secondary" onClick={() => setIsExportModalOpen(true)} style={{ background: 'rgba(79, 70, 229, 0.1)', color: 'var(--accent)', border: '1px solid rgba(79, 70, 229, 0.2)' }}>
                      💼 Jira Export
                    </button>
                    <button className="btn-primary" onClick={startDryRun} style={{ background: 'var(--primary)', boxShadow: '0 4px 12px var(--primary-glow)' }}>
                      ▶️ Start Dry-Run
                    </button>
                  </>
                )}
              </div>
            </div>

            {testCases.length === 0 ? (
              <div className="empty-state">
                <h3>No test cases loaded</h3>
                <p>Input a User Story and Acceptance Criteria in the AI Generator tab, or reload a past record in the History Dashboard tab to view details.</p>
              </div>
            ) : (
              <div className="tc-grid">
                {testCases.map((tc) => (
                  <div key={tc.id} className="tc-card">
                    {editingTcId === tc.id ? (
                      // Edit Mode UI
                      <>
                        <div className="tc-edit-row-flex">
                          <input
                            type="text"
                            className="tc-edit-input"
                            value={editingTcData.title}
                            onChange={(e) => setEditingTcData({ ...editingTcData, title: e.target.value })}
                            placeholder="Test Case Title"
                          />
                        </div>
                        <div className="tc-edit-row-flex">
                          <select
                            className="tc-edit-select"
                            value={editingTcData.type}
                            onChange={(e) => setEditingTcData({ ...editingTcData, type: e.target.value })}
                          >
                            <option value="Positive">Positive</option>
                            <option value="Negative">Negative</option>
                            <option value="Edge">Edge</option>
                            <option value="Security">Security</option>
                            <option value="Performance">Performance</option>
                          </select>
                          <select
                            className="tc-edit-select"
                            value={editingTcData.priority}
                            onChange={(e) => setEditingTcData({ ...editingTcData, priority: e.target.value })}
                          >
                            <option value="High">High</option>
                            <option value="Medium">Medium</option>
                            <option value="Low">Low</option>
                          </select>
                        </div>
                        {editingTcData.format === 'LLY TU' ? (
                          <>
                            <div className="detail-row">
                              <label className="detail-label">Test Path</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'testPath')}
                                onChange={(e) => updateCustomField('testPath', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Designer</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'designer')}
                                onChange={(e) => updateCustomField('designer', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Category</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'category')}
                                onChange={(e) => updateCustomField('category', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Description</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'description')}
                                onChange={(e) => updateCustomField('description', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Preconditions</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={editingTcData.preconditions}
                                onChange={(e) => setEditingTcData({ ...editingTcData, preconditions: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Step Name</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'stepName')}
                                onChange={(e) => updateCustomField('stepName', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Step Description</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.steps}
                                onChange={(e) => setEditingTcData({ ...editingTcData, steps: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Expected Result</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.expectedResult}
                                onChange={(e) => setEditingTcData({ ...editingTcData, expectedResult: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Evidence Required</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'evidenceRequired')}
                                onChange={(e) => updateCustomField('evidenceRequired', e.target.value)}
                              />
                            </div>
                          </>
                        ) : editingTcData.format === 'LLY PBPA' ? (
                          <>
                            <div className="detail-row">
                              <label className="detail-label">Test Case Description</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'testCaseDescription')}
                                onChange={(e) => updateCustomField('testCaseDescription', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Preconditions</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={editingTcData.preconditions}
                                onChange={(e) => setEditingTcData({ ...editingTcData, preconditions: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Steps to be Followed</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.steps}
                                onChange={(e) => setEditingTcData({ ...editingTcData, steps: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Expected Result</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.expectedResult}
                                onChange={(e) => setEditingTcData({ ...editingTcData, expectedResult: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Actual Result</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'actualResult')}
                                onChange={(e) => updateCustomField('actualResult', e.target.value)}
                              />
                            </div>
                          </>
                        ) : editingTcData.format === 'DEL' ? (
                          <>
                            <div className="detail-row">
                              <label className="detail-label">Description</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'description') || editingTcData.title}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const currentFields = typeof editingTcData.customFields === 'string'
                                    ? JSON.parse(editingTcData.customFields || '{}')
                                    : (editingTcData.customFields || {});
                                  setEditingTcData({
                                    ...editingTcData,
                                    title: val,
                                    customFields: {
                                      ...currentFields,
                                      description: val
                                    }
                                  });
                                }}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Preconditions</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={editingTcData.preconditions}
                                onChange={(e) => setEditingTcData({ ...editingTcData, preconditions: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Test Data</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'testData')}
                                onChange={(e) => updateCustomField('testData', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Test Steps</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.steps}
                                onChange={(e) => setEditingTcData({ ...editingTcData, steps: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Expected Result</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.expectedResult}
                                onChange={(e) => setEditingTcData({ ...editingTcData, expectedResult: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Actual Result</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'actualResult')}
                                onChange={(e) => updateCustomField('actualResult', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Bug ID</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'bugId')}
                                onChange={(e) => updateCustomField('bugId', e.target.value)}
                              />
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="detail-row">
                              <label className="detail-label">Description</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={getCustomField(editingTcData, 'description')}
                                onChange={(e) => updateCustomField('description', e.target.value)}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Preconditions</label>
                              <input
                                type="text"
                                className="tc-edit-input"
                                value={editingTcData.preconditions}
                                onChange={(e) => setEditingTcData({ ...editingTcData, preconditions: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Steps</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.steps}
                                onChange={(e) => setEditingTcData({ ...editingTcData, steps: e.target.value })}
                              />
                            </div>
                            <div className="detail-row">
                              <label className="detail-label">Expected Result</label>
                              <textarea
                                className="tc-edit-textarea"
                                value={editingTcData.expectedResult}
                                onChange={(e) => setEditingTcData({ ...editingTcData, expectedResult: e.target.value })}
                              />
                            </div>
                          </>
                        )}
                        <div className="tc-card-actions">
                          <button className="btn-primary" onClick={handleEditSave} style={{ padding: '6px 14px', borderRadius: '6px' }}>
                            Save
                          </button>
                          <button className="btn-secondary" onClick={() => setEditingTcId(null)} style={{ padding: '6px 14px' }}>
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      // Read Mode UI
                      <>
                        <div className="tc-card-header">
                          <div className="tc-title-flex">
                            <span className="tc-id-badge">{tc.customId || tc.id}</span>
                            <span className="tc-title">{tc.title}</span>
                          </div>
                          <div className="tc-badges">
                            <span className={`badge ${tc.type.toLowerCase()}`}>{tc.type}</span>
                            <span className={`badge priority-${(tc.priority || 'medium').toLowerCase()}`}>{tc.priority}</span>
                            <span className={`badge status-${(tc.executionStatus || 'pending').toLowerCase()}`}>
                              {tc.executionStatus || 'Pending'}
                            </span>
                          </div>
                        </div>

                        {(() => {
                          const currentView = cardViews[tc.id] || 'manual';
                          if (currentView === 'gherkin') {
                            return (
                              <div className="tc-details bdd-details">
                                <div className="detail-row">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                    <span className="detail-label">BDD Gherkin Scenario</span>
                                    <button className="copy-bdd-btn" onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(convertToGherkin(tc));
                                      const btn = e.target;
                                      btn.textContent = '✅ Copied!';
                                      setTimeout(() => { btn.textContent = '📋 Copy BDD'; }, 1500);
                                    }} style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', cursor: 'pointer', color: 'var(--text-sub)' }}>
                                      📋 Copy BDD
                                    </button>
                                  </div>
                                  <pre className="gherkin-text" style={{ margin: 0, padding: '10px', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--text-main)', overflowX: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: '1.4' }}>
                                    {convertToGherkin(tc)}
                                  </pre>
                                </div>
                              </div>
                            );
                          } else if (currentView === 'playwright') {
                            return (
                              <div className="tc-details playwright-details">
                                <div className="detail-row">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                    <span className="detail-label">Playwright Automation Code</span>
                                    <button className="copy-bdd-btn" onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(convertToPlaywright(tc));
                                      const btn = e.target;
                                      btn.textContent = '✅ Copied!';
                                      setTimeout(() => { btn.textContent = '📋 Copy Code'; }, 1500);
                                    }} style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', cursor: 'pointer', color: 'var(--text-sub)' }}>
                                      📋 Copy Code
                                    </button>
                                  </div>
                                  <pre className="gherkin-text" style={{ margin: 0, padding: '10px', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--text-main)', overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'monospace', lineHeight: '1.4' }}>
                                    {convertToPlaywright(tc)}
                                  </pre>
                                </div>
                              </div>
                            );
                          } else if (currentView === 'cypress') {
                            return (
                              <div className="tc-details cypress-details">
                                <div className="detail-row">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                    <span className="detail-label">Cypress Automation Code</span>
                                    <button className="copy-bdd-btn" onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(convertToCypress(tc));
                                      const btn = e.target;
                                      btn.textContent = '✅ Copied!';
                                      setTimeout(() => { btn.textContent = '📋 Copy Code'; }, 1500);
                                    }} style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', cursor: 'pointer', color: 'var(--text-sub)' }}>
                                      📋 Copy Code
                                    </button>
                                  </div>
                                  <pre className="gherkin-text" style={{ margin: 0, padding: '10px', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--text-main)', overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'monospace', lineHeight: '1.4' }}>
                                    {convertToCypress(tc)}
                                  </pre>
                                </div>
                              </div>
                            );
                          } else {
                            return (
                              <div className="tc-details">
                                {format === 'LLY TU' ? (
                                  <>
                                    <div className="detail-row">
                                      <span className="detail-label">Test Path</span>
                                      <span className="detail-value">{getCustomField(tc, 'testPath') || '/DefaultPath/Section'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Designer</span>
                                      <span className="detail-value">{getCustomField(tc, 'designer') || 'QA Team'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Category</span>
                                      <span className="detail-value">{getCustomField(tc, 'category') || 'General'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Description</span>
                                      <span className="detail-value">{getCustomField(tc, 'description') || tc.title || 'Verify the scenario.'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Preconditions</span>
                                      <span className="detail-value">{tc.preconditions || 'N/A'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Step Name</span>
                                      <span className="detail-value">{getCustomField(tc, 'stepName') || 'Perform Action'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Step Description</span>
                                      <span className="detail-value">{tc.steps}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Expected Result</span>
                                      <span className="detail-value">{tc.expectedResult}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Evidence Required</span>
                                      <span className="detail-value">{getCustomField(tc, 'evidenceRequired') || 'No'}</span>
                                    </div>
                                  </>
                                ) : format === 'LLY PBPA' ? (
                                  <>
                                    <div className="detail-row">
                                      <span className="detail-label">Test Summary</span>
                                      <span className="detail-value">{tc.title}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Test Case Description</span>
                                      <span className="detail-value">{getCustomField(tc, 'testCaseDescription') || getCustomField(tc, 'description') || tc.title || 'Verify function.'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Preconditions</span>
                                      <span className="detail-value">{tc.preconditions || 'N/A'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Steps to be Followed</span>
                                      <span className="detail-value">{tc.steps}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Expected Result</span>
                                      <span className="detail-value">{tc.expectedResult}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Actual Result</span>
                                      <span className="detail-value">{getCustomField(tc, 'actualResult') || 'N/A'}</span>
                                    </div>
                                  </>
                                ) : format === 'DEL' ? (
                                  <>
                                    <div className="detail-row">
                                      <span className="detail-label">Description</span>
                                      <span className="detail-value">{tc.title}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Preconditions</span>
                                      <span className="detail-value">{tc.preconditions || 'N/A'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Test Data</span>
                                      <span className="detail-value">{getCustomField(tc, 'testData') || 'Valid credentials'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Test Steps</span>
                                      <span className="detail-value">{tc.steps}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Expected Result</span>
                                      <span className="detail-value">{tc.expectedResult}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Actual Result</span>
                                      <span className="detail-value">{getCustomField(tc, 'actualResult') || 'N/A'}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Bug ID</span>
                                      <span className="detail-value">{getCustomField(tc, 'bugId') || 'N/A'}</span>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div className="detail-row">
                                      <span className="detail-label">Description</span>
                                      <span className="detail-value">{getCustomField(tc, 'description') || tc.title || 'Verify the scenario.'}</span>
                                    </div>
                                    {tc.preconditions && tc.preconditions !== 'N/A' && (
                                      <div className="detail-row">
                                        <span className="detail-label">Preconditions</span>
                                        <span className="detail-value">{tc.preconditions}</span>
                                      </div>
                                    )}
                                    <div className="detail-row">
                                      <span className="detail-label">Steps</span>
                                      <span className="detail-value">{tc.steps}</span>
                                    </div>
                                    <div className="detail-row">
                                      <span className="detail-label">Expected Result</span>
                                      <span className="detail-value">{tc.expectedResult}</span>
                                    </div>
                                  </>
                                )}
                                {tc.executionComments && (
                                  <div className="detail-row execution-notes-row" style={{ marginTop: '8px', padding: '6px 8px', background: 'var(--bg-glass-hover)', borderLeft: '3px solid var(--text-muted)', borderRadius: '0 4px 4px 0' }}>
                                    <span className="detail-label" style={{ display: 'block', fontSize: '10.5px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Execution Run Comments</span>
                                    <span className="detail-value" style={{ fontStyle: 'italic', fontSize: '12px', color: 'var(--text-sub)' }}>"{tc.executionComments}"</span>
                                  </div>
                                )}
                              </div>
                            );
                          }
                        })()}

                        <div className="tc-card-actions">
                          <select
                            className="sidebar-select"
                            value={cardViews[tc.id] || 'manual'}
                            onChange={(e) => setCardViews(prev => ({ ...prev, [tc.id]: e.target.value }))}
                            style={{ width: 'auto', padding: '4px 8px', fontSize: '12px', height: '32px', cursor: 'pointer', background: 'var(--bg-glass-hover)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: '6px' }}
                          >
                            <option value="manual">📝 Manual Steps</option>
                            <option value="gherkin">🤖 BDD (Gherkin)</option>
                            <option value="playwright">🎭 Playwright Code</option>
                            <option value="cypress">🌲 Cypress Code</option>
                          </select>
                          <button className="card-action-btn" onClick={() => handleEditClick(tc)}>
                            ✏️ Edit
                          </button>
                          <button className="card-action-btn delete" onClick={() => handleDeleteTestCase(tc.id)}>
                            🗑️ Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: History Dashboard */}
        {activeTab === 'history' && (
          <div className="tab-content">
            <div style={{ marginBottom: '20px' }}>
              <h2 style={{ fontFamily: 'Outfit, sans-serif' }}>History & Past Records</h2>
              <span className="repo-subtitle">
                Retrieve and reload past test case generation runs for user: <strong>{userId}</strong>
              </span>
            </div>

            {loadingStories ? (
              <span style={{ color: 'var(--text-sub)' }}>Loading records...</span>
            ) : pastStories.length === 0 ? (
              <div className="empty-state">
                <h3>No records found</h3>
                <p>Generated test suites for user <strong>{userId}</strong> will appear here for easy retrieval and editing.</p>
              </div>
            ) : (
              <div className="history-grid">
                {pastStories.map((story) => (
                  <div key={story.id} className="history-card" onClick={() => handleLoadPastStory(story)}>
                    <div className="history-card-header">
                      <span className="history-card-date">
                        {new Date(parseInt(story.id.split('-')[1]) || Date.now()).toLocaleDateString()}
                      </span>
                      <button className="history-delete-btn" onClick={(e) => handleDeletePastStory(e, story.id)}>
                        🗑️
                      </button>
                    </div>
                    <span className="history-card-title">{story.title}</span>
                    <p className="history-card-desc">{story.description}</p>
                    <div className="history-card-stats">
                      <span>📁 {story.testCases?.length || 0} Test Cases</span>
                      {story.chatId && <span>💬 Chat Session linked</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: QA Analytics & Coverage */}
        {activeTab === 'analytics' && (
          <div className="tab-content" style={{ overflowY: 'auto', padding: '24px' }}>
            <div style={{ marginBottom: '20px' }}>
              <h2 style={{ fontFamily: 'Outfit, sans-serif' }}>QA Analytics & Coverage Dashboard</h2>
              <span className="repo-subtitle">
                Comprehensive metrics and requirement mapping for: <strong>{activeStory ? activeStory.title : 'No active user story'}</strong>
              </span>
            </div>

            {!activeStory ? (
              <div className="empty-state">
                <h3>No active user story loaded</h3>
                <p>Please generate a new test suite or reload an existing one from the History Dashboard to view analytics.</p>
              </div>
            ) : (
              <div className="analytics-layout">
                {/* Metrics Summary Row */}
                <div className="metrics-grid">
                  <div className="metric-card">
                    <span className="metric-title">Total Test Cases</span>
                    <span className="metric-value">{testCases.length}</span>
                  </div>
                  
                  <div className="metric-card">
                    <span className="metric-title">Acceptance Criteria (AC)</span>
                    <span className="metric-value">
                      {activeStory.acceptanceCriteria ? activeStory.acceptanceCriteria.length : 0}
                    </span>
                  </div>

                  <div className="metric-card">
                    <span className="metric-title">AC Coverage</span>
                    <span className="metric-value">
                      {(() => {
                        const totalAc = activeStory.acceptanceCriteria ? activeStory.acceptanceCriteria.length : 0;
                        if (totalAc === 0) return '0%';
                        let coveredCount = 0;
                        activeStory.acceptanceCriteria.forEach((ac, idx) => {
                          const tag = `[AC${idx + 1}]`;
                          const isCovered = testCases.some(tc => 
                            (tc.preconditions && tc.preconditions.toLowerCase().includes(tag.toLowerCase())) ||
                            (tc.title && tc.title.toLowerCase().includes(tag.toLowerCase()))
                          );
                          if (isCovered) coveredCount++;
                        });
                        return `${Math.round((coveredCount / (totalAc || 1)) * 100)}%`;
                      })()}
                    </span>
                  </div>

                  <div className="metric-card">
                    <span className="metric-title">Pass Rate</span>
                    <span className="metric-value">
                      {(() => {
                        const executed = testCases.filter(tc => tc.executionStatus && tc.executionStatus !== 'Pending');
                        if (executed.length === 0) return 'N/A';
                        const passed = executed.filter(tc => tc.executionStatus === 'Passed');
                        return `${Math.round((passed.length / executed.length) * 100)}%`;
                      })()}
                    </span>
                  </div>
                </div>

                {/* Visual CSS Charts Section */}
                <div className="charts-flex-row">
                  {/* Chart 1: Priority Distribution */}
                  <div className="chart-container-card">
                    <h3>Priority Distribution</h3>
                    <div className="css-chart-content">
                      {(() => {
                        const counts = { High: 0, Medium: 0, Low: 0 };
                        testCases.forEach(tc => {
                          const p = tc.priority || 'Medium';
                          if (counts[p] !== undefined) counts[p]++;
                        });
                        const total = testCases.length || 1;
                        const pct = {
                          High: Math.round((counts.High / total) * 100),
                          Medium: Math.round((counts.Medium / total) * 100),
                          Low: Math.round((counts.Low / total) * 100)
                        };
                        return (
                          <div className="bar-chart-vertical">
                            <div className="bar-item">
                              <span className="bar-label">High ({counts.High})</span>
                              <div className="bar-track">
                                <div className="bar-fill priority-high-fill" style={{ width: `${pct.High}%` }}></div>
                              </div>
                              <span className="bar-pct">{pct.High}%</span>
                            </div>
                            <div className="bar-item">
                              <span className="bar-label">Medium ({counts.Medium})</span>
                              <div className="bar-track">
                                <div className="bar-fill priority-medium-fill" style={{ width: `${pct.Medium}%` }}></div>
                              </div>
                              <span className="bar-pct">{pct.Medium}%</span>
                            </div>
                            <div className="bar-item">
                              <span className="bar-label">Low ({counts.Low})</span>
                              <div className="bar-track">
                                <div className="bar-fill priority-low-fill" style={{ width: `${pct.Low}%` }}></div>
                              </div>
                              <span className="bar-pct">{pct.Low}%</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Chart 2: Execution Progress */}
                  <div className="chart-container-card">
                    <h3>Execution Status</h3>
                    <div className="css-chart-content">
                      {(() => {
                        const counts = { Passed: 0, Failed: 0, Blocked: 0, Pending: 0 };
                        testCases.forEach(tc => {
                          const s = tc.executionStatus || 'Pending';
                          if (counts[s] !== undefined) counts[s]++;
                          else counts.Pending++;
                        });
                        const total = testCases.length || 1;
                        const pct = {
                          Passed: Math.round((counts.Passed / total) * 100),
                          Failed: Math.round((counts.Failed / total) * 100),
                          Blocked: Math.round((counts.Blocked / total) * 100),
                          Pending: Math.round((counts.Pending / total) * 100)
                        };
                        return (
                          <div className="execution-pie-legend-row">
                            <div className="conic-pie-chart" style={{
                              background: `conic-gradient(
                                var(--positive-color) 0% ${pct.Passed}%,
                                var(--negative-color) ${pct.Passed}% ${pct.Passed + pct.Failed}%,
                                var(--security-color) ${pct.Passed + pct.Failed}% ${pct.Passed + pct.Failed + pct.Blocked}%,
                                var(--text-muted) ${pct.Passed + pct.Failed + pct.Blocked}% 100%
                              )`
                            }}>
                              <div className="pie-chart-center">
                                <span>{pct.Passed}% Pass</span>
                              </div>
                            </div>
                            <div className="pie-legend">
                              <div className="legend-item">
                                <span className="legend-dot" style={{ background: 'var(--positive-color)' }}></span>
                                <span>Passed: {counts.Passed} ({pct.Passed}%)</span>
                              </div>
                              <div className="legend-item">
                                <span className="legend-dot" style={{ background: 'var(--negative-color)' }}></span>
                                <span>Failed: {counts.Failed} ({pct.Failed}%)</span>
                              </div>
                              <div className="legend-item">
                                <span className="legend-dot" style={{ background: 'var(--security-color)' }}></span>
                                <span>Blocked: {counts.Blocked} ({pct.Blocked}%)</span>
                              </div>
                              <div className="legend-item">
                                <span className="legend-dot" style={{ background: 'var(--text-muted)' }}></span>
                                <span>Pending: {counts.Pending} ({pct.Pending}%)</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Chart 3: Test Scenario Types Split */}
                  <div className="chart-container-card">
                    <h3>Scenario Types</h3>
                    <div className="css-chart-content">
                      {(() => {
                        const counts = { Positive: 0, Negative: 0, Edge: 0, Security: 0, Performance: 0 };
                        testCases.forEach(tc => {
                          const t = tc.type || 'Positive';
                          if (counts[t] !== undefined) counts[t]++;
                        });
                        const total = testCases.length || 1;
                        return (
                          <div className="types-donut-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                            {Object.keys(counts).map(key => {
                              const value = counts[key];
                              const colorVar = `var(--${key.toLowerCase()}-color)`;
                              const pct = Math.round((value / total) * 100);
                              return (
                                <div key={key} className="type-row-stat" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                                  <div className="type-meta" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: '90px' }}>
                                    <span className="type-color-bar" style={{ width: '8px', height: '8px', borderRadius: '50%', background: colorVar }}></span>
                                    <span className="type-name" style={{ fontSize: '12px', fontWeight: '500' }}>{key}</span>
                                  </div>
                                  <div className="type-bar-container" style={{ flexGrow: 1, height: '6px', background: 'var(--bg-app)', borderRadius: '3px', overflow: 'hidden' }}>
                                    <div className="type-bar-fill" style={{ height: '100%', width: `${pct}%`, background: colorVar }}></div>
                                  </div>
                                  <span className="type-value" style={{ fontSize: '11px', fontWeight: '600', minWidth: '60px', textAlign: 'right' }}>{value} ({pct}%)</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Requirement Traceability Matrix (RTM) */}
                <div className="rtm-container-card">
                  <h3>Requirement Traceability Matrix (RTM)</h3>
                  <p className="rtm-desc">Mapping of business Acceptance Criteria (AC) to validated Test Scenarios.</p>
                  
                  {!activeStory.acceptanceCriteria || activeStory.acceptanceCriteria.length === 0 ? (
                    <div className="rtm-empty">
                      <span>No acceptance criteria extracted for this story.</span>
                    </div>
                  ) : (
                    <table className="rtm-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: '12px' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-color)', color: 'var(--text-sub)' }}>
                          <th style={{ padding: '10px', fontSize: '12px', fontWeight: '600' }}>AC ID</th>
                          <th style={{ padding: '10px', fontSize: '12px', fontWeight: '600' }}>Acceptance Criterion Description</th>
                          <th style={{ padding: '10px', fontSize: '12px', fontWeight: '600' }}>Status</th>
                          <th style={{ padding: '10px', fontSize: '12px', fontWeight: '600' }}>Mapping Test Cases</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeStory.acceptanceCriteria.map((ac, idx) => {
                          const tag = `[AC${idx + 1}]`;
                          const mappingCases = testCases.filter(tc => 
                            (tc.preconditions && tc.preconditions.toLowerCase().includes(tag.toLowerCase())) ||
                            (tc.title && tc.title.toLowerCase().includes(tag.toLowerCase()))
                          );
                          const isCovered = mappingCases.length > 0;
                          return (
                            <tr key={ac.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                              <td className="rtm-ac-id" style={{ padding: '10px', fontSize: '12px', fontWeight: '600', color: 'var(--primary)' }}>AC-{idx + 1}</td>
                              <td className="rtm-ac-content" style={{ padding: '10px', fontSize: '12.5px', color: 'var(--text-main)', lineHeight: '1.4' }}>{ac.content}</td>
                              <td style={{ padding: '10px' }}>
                                <span className={`rtm-badge ${isCovered ? 'covered' : 'uncovered'}`} style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '10.5px', fontWeight: '600', background: isCovered ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isCovered ? 'var(--positive-color)' : 'var(--negative-color)' }}>
                                  {isCovered ? 'Covered' : 'Uncovered'}
                                </span>
                              </td>
                              <td className="rtm-mappings" style={{ padding: '10px' }}>
                                {isCovered ? (
                                  <div className="rtm-links-flex" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                    {mappingCases.map(tc => (
                                      <span key={tc.id} className="rtm-tc-link" style={{ cursor: 'pointer', background: 'var(--primary-glow)', color: 'var(--primary)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: '600', border: '1px solid var(--border-focus)' }} title={tc.title}>
                                        {tc.id}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>None</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3>QAtlas Configuration</h3>
              <button className="modal-close" onClick={() => setIsSettingsOpen(false)}>✕</button>
            </div>
            
            <div className="form-group">
              <label>Active User (For Data Segregation)</label>
              <input
                type="text"
                className="sidebar-input"
                value={tempUserId}
                onChange={(e) => setTempUserId(e.target.value)}
                placeholder="e.g. Alex Morgan"
              />
              <span className="upload-hint" style={{ marginTop: '2px' }}>
                Toggle user profiles to demonstrate complete SQLite record segregation.
              </span>
            </div>

            <div className="form-group">
              <label>Model Provider</label>
              <select
                className="sidebar-select"
                value={tempProvider}
                onChange={(e) => setTempProvider(e.target.value)}
              >
                <option value="gemini">Google Gemini 3.5 Flash</option>
                <option value="claude">Anthropic Claude Opus 4.8</option>
                <option value="chatgpt">ChatGPT (GPT-5.5)</option>
                <option value="copilot">Microsoft Copilot (GPT-5.5 + multi-model)</option>
              </select>
            </div>

            {tempProvider === 'gemini' && (
              <div className="form-group">
                <label>Gemini API Key (Free Tier Available)</label>
                <input
                  type="password"
                  className="sidebar-input"
                  value={tempGeminiKey}
                  onChange={(e) => setTempGeminiKey(e.target.value)}
                  placeholder={geminiKey ? "••••••••••••••••" : "Paste Gemini API Key here..."}
                />
                <span className="upload-hint" style={{ marginTop: '4px', display: 'block' }}>
                  Create a 100% free developer key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'underline' }}>Google AI Studio</a>.
                </span>
              </div>
            )}

            {tempProvider === 'claude' && (
              <div className="form-group">
                <label>Claude API Key</label>
                <input
                  type="password"
                  className="sidebar-input"
                  value={tempClaudeKey}
                  onChange={(e) => setTempClaudeKey(e.target.value)}
                  placeholder={claudeKey ? "••••••••••••••••" : "Paste Claude API Key here..."}
                />
              </div>
            )}

            {tempProvider === 'chatgpt' && (
              <div className="form-group">
                <label>OpenAI/ChatGPT API Key</label>
                <input
                  type="password"
                  className="sidebar-input"
                  value={tempOpenaiKey}
                  onChange={(e) => setTempOpenaiKey(e.target.value)}
                  placeholder={openaiKey ? "••••••••••••••••" : "Paste OpenAI API Key here..."}
                />
              </div>
            )}

            {tempProvider === 'copilot' && (
              <div className="form-group">
                <label>Copilot API Key</label>
                <input
                  type="password"
                  className="sidebar-input"
                  value={tempCopilotKey}
                  onChange={(e) => setTempCopilotKey(e.target.value)}
                  placeholder={copilotKey ? "••••••••••••••••" : "Paste Copilot API Key here..."}
                />
              </div>
            )}

            <span className="upload-hint" style={{ marginTop: '12px', display: 'block', marginBottom: '8px' }}>
              Keys are saved locally in your browser. If a key is missing for your selected provider, QAtlas falls back to the advanced heuristic mock generator.
            </span>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setIsSettingsOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleSaveSettings}>
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dry-Run Simulator Modal */}
      {dryRunCases && (
        <div className="modal-backdrop dry-run-modal-backdrop" style={{ zIndex: 1100 }}>
          <div className="modal-content dry-run-modal-content" style={{ maxWidth: '650px', width: '90%' }}>
            <div className="modal-header">
              <h3>Manual Test Dry-Run Simulator</h3>
              <button className="modal-close" onClick={() => setDryRunCases(null)}>✕</button>
            </div>
            
            {currentDryRunIndex < dryRunCases.length ? (
              (() => {
                const tc = dryRunCases[currentDryRunIndex];
                const stepsList = (tc.steps || '').split('\n').filter(s => s.trim().length > 0);
                return (
                  <div className="dry-run-wizard">
                    <div className="dry-run-progress-container" style={{ width: '100%', height: '8px', background: 'var(--bg-app)', borderRadius: '4px', margin: '8px 0', overflow: 'hidden' }}>
                      <div className="dry-run-progress-fill" style={{ height: '100%', background: 'var(--primary)', width: `${((currentDryRunIndex) / dryRunCases.length) * 100}%`, transition: 'width 0.3s ease' }}></div>
                    </div>
                    <div className="dry-run-counter" style={{ display: 'block', fontSize: '12px', color: 'var(--text-sub)', marginBottom: '14px', textAlign: 'right', fontWeight: '500' }}>
                      Scenario {currentDryRunIndex + 1} of {dryRunCases.length}
                    </div>
                    
                    <div className="dry-run-case-card" style={{ padding: '16px', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                      <div className="dry-run-case-header" style={{ marginBottom: '10px' }}>
                        <span className="dry-run-id" style={{ background: 'var(--primary-glow)', color: 'var(--primary)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: '700', marginRight: '8px' }}>{tc.id}</span>
                        <span className="dry-run-title" style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-main)' }}>{tc.title}</span>
                      </div>
                      
                      <div className="dry-run-badges" style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        <span className={`badge ${tc.type.toLowerCase()}`}>{tc.type}</span>
                        <span className={`badge priority-${(tc.priority || 'medium').toLowerCase()}`}>{tc.priority}</span>
                      </div>
                      
                      {tc.preconditions && tc.preconditions !== 'N/A' && (
                        <div className="dry-run-preconditions" style={{ fontSize: '12.5px', marginBottom: '10px', padding: '8px', background: 'var(--bg-sidebar)', borderRadius: '6px', borderLeft: '3px solid var(--accent)' }}>
                          <strong>Preconditions:</strong> {tc.preconditions}
                        </div>
                      )}
                      
                      <div className="dry-run-section" style={{ marginBottom: '12px' }}>
                        <strong>Steps Checklist (Check off to proceed):</strong>
                        <div className="dry-run-steps-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                          {stepsList.map((step, idx) => (
                            <label key={idx} className="dry-run-step-label" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12.5px', color: 'var(--text-main)' }}>
                              <input 
                                type="checkbox"
                                checked={!!dryRunStepChecks[idx]}
                                onChange={(e) => setDryRunStepChecks({ ...dryRunStepChecks, [idx]: e.target.checked })}
                                style={{ marginTop: '3px', cursor: 'pointer' }}
                              />
                              <span style={{ textDecoration: dryRunStepChecks[idx] ? 'line-through' : 'none', color: dryRunStepChecks[idx] ? 'var(--text-muted)' : 'var(--text-main)' }}>{step}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      
                      <div className="dry-run-expected" style={{ fontSize: '12.5px', padding: '10px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)', borderRadius: '6px' }}>
                        <strong>Expected Result:</strong>
                        <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)' }}>{tc.expectedResult}</p>
                      </div>
                    </div>
                    
                    <div className="form-group" style={{ marginTop: '16px' }}>
                      <label>Execution Comments / Run Notes</label>
                      <textarea
                        className="sidebar-textarea"
                        placeholder="Log test outcomes, observed errors, version numbers, or blocker descriptions..."
                        value={dryRunComments}
                        onChange={(e) => setDryRunComments(e.target.value)}
                        style={{ minHeight: '80px', width: '100%', padding: '10px', background: 'var(--bg-sidebar)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-main)', fontSize: '13px' }}
                      />
                    </div>
                    
                    <div className="dry-run-actions" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px', gap: '10px' }}>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="btn-secondary" onClick={() => setDryRunCases(null)}>
                          Exit Run
                        </button>
                        <button className="btn-secondary" onClick={() => setCurrentDryRunIndex(prev => prev + 1)}>
                          Skip
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="btn-secondary" onClick={() => handleDryRunSaveStatus('Blocked')} style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--security-color)', border: '1px solid rgba(245,158,11,0.2)' }}>
                          🚫 Blocked
                        </button>
                        <button className="btn-secondary" onClick={() => handleDryRunSaveStatus('Failed')} style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--negative-color)', border: '1px solid rgba(239,68,68,0.2)' }}>
                          ❌ Failed
                        </button>
                        <button className="btn-primary" onClick={() => handleDryRunSaveStatus('Passed')} style={{ background: 'var(--positive-color)', color: '#fff', border: 'none', boxShadow: '0 4px 10px rgba(16,185,129,0.2)' }}>
                          ✅ Passed
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="dry-run-completion" style={{ textAlign: 'center', padding: '20px 10px' }}>
                <div className="completion-icon" style={{ fontSize: '48px', marginBottom: '10px' }}>🎉</div>
                <h3 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Dry-Run Session Complete!</h3>
                <p style={{ color: 'var(--text-sub)', fontSize: '13.5px', marginBottom: '24px' }}>All test scenarios have been executed and status metrics are updated.</p>
                
                <div className="completion-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', margin: '20px 0' }}>
                  <div className="stat-box" style={{ background: 'var(--bg-app)', padding: '12px', borderRadius: '8px' }}>
                    <span className="stat-label" style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>Total Suite</span>
                    <span className="stat-val" style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text-main)' }}>{dryRunCases.length}</span>
                  </div>
                  <div className="stat-box box-passed" style={{ background: 'rgba(16,185,129,0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span className="stat-label" style={{ display: 'block', fontSize: '11px', color: 'var(--positive-color)' }}>Passed</span>
                    <span className="stat-val" style={{ fontSize: '18px', fontWeight: '700', color: 'var(--positive-color)' }}>{dryRunCases.filter(c => c.executionStatus === 'Passed').length}</span>
                  </div>
                  <div className="stat-box box-failed" style={{ background: 'rgba(239,68,68,0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span className="stat-label" style={{ display: 'block', fontSize: '11px', color: 'var(--negative-color)' }}>Failed</span>
                    <span className="stat-val" style={{ fontSize: '18px', fontWeight: '700', color: 'var(--negative-color)' }}>{dryRunCases.filter(c => c.executionStatus === 'Failed').length}</span>
                  </div>
                  <div className="stat-box box-blocked" style={{ background: 'rgba(245,158,11,0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span className="stat-label" style={{ display: 'block', fontSize: '11px', color: 'var(--security-color)' }}>Blocked</span>
                    <span className="stat-val" style={{ fontSize: '18px', fontWeight: '700', color: 'var(--security-color)' }}>{dryRunCases.filter(c => c.executionStatus === 'Blocked').length}</span>
                  </div>
                </div>
                
                <div className="modal-actions" style={{ justifyContent: 'center', marginTop: '24px' }}>
                  <button className="btn-primary" onClick={() => setDryRunCases(null)}>
                    Close Simulator
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Jira Export Modal */}
      {isExportModalOpen && (
        <div className="modal-backdrop" style={{ zIndex: 1100 }}>
          <div className="modal-content" style={{ maxWidth: '700px', width: '90%' }}>
            <div className="modal-header">
              <h3>Jira QA Exporter</h3>
              <button className="modal-close" onClick={() => setIsExportModalOpen(false)}>✕</button>
            </div>
            
            <div className="export-modal-tabs" style={{ padding: '10px 0' }}>
              <div className="export-info-text" style={{ fontSize: '13px', color: 'var(--text-sub)', marginBottom: '16px', lineHeight: '1.4' }}>
                Generate formatted artifacts ready to copy directly into your Jira issue description.
              </div>
              
              <div className="export-section" style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <strong style={{ fontSize: '13.5px' }}>Jira Description Markdown Table:</strong>
                  <button className="copy-bdd-btn" onClick={(e) => {
                    navigator.clipboard.writeText(getJiraMarkdown());
                    const btn = e.target;
                    btn.textContent = '✅ Copied!';
                    setTimeout(() => { btn.textContent = '📋 Copy Table Markdown'; }, 1500);
                  }} style={{ padding: '4px 10px', fontSize: '11.5px', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', cursor: 'pointer', color: 'var(--primary)', fontWeight: '600' }}>
                    📋 Copy Table Markdown
                  </button>
                </div>
                <textarea
                  readOnly
                  className="export-markdown-textarea"
                  value={getJiraMarkdown()}
                  style={{ width: '100%', height: '160px', fontFamily: 'monospace', fontSize: '11.5px', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px', color: 'var(--text-main)', resize: 'none' }}
                />
              </div>
            </div>
            
            <div className="modal-actions" style={{ marginTop: '20px' }}>
              <button className="btn-secondary" onClick={() => setIsExportModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

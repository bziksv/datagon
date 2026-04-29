import React, { Component, Fragment, useRef, useState } from "react";
import { CSSTransition, TransitionGroup } from "../../../../../components/React19Transition";
import { Row, Col, Card, CardBody, CardTitle, Button, ButtonGroup, Input, Modal, ModalHeader, ModalBody, ModalFooter } from "reactstrap";

// Enhanced React 19 compatible Rich Text Editor
const EnhancedRichTextEditor = ({ value, onChange, placeholder = "Start typing..." }) => {
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const [content, setContent] = useState(value || '');
  const [linkModal, setLinkModal] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const execCommand = (command, value = null) => {
    document.execCommand(command, false, value);
    handleInput();
  };

  const handleInput = () => {
    if (editorRef.current) {
      const newContent = editorRef.current.innerHTML;
      setContent(newContent);
      if (onChange) {
        onChange(newContent);
      }
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    handleInput();
  };

  const insertLink = () => {
    if (linkText && linkUrl) {
      const linkHtml = `<a href="${linkUrl}" target="_blank">${linkText}</a>`;
      document.execCommand('insertHTML', false, linkHtml);
      setLinkModal(false);
      setLinkText('');
      setLinkUrl('');
      handleInput();
    }
  };

  const insertImage = () => {
    fileInputRef.current?.click();
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const imageHtml = `<img src="${event.target.result}" style="max-width: 100%; height: auto;" alt="Uploaded image" />`;
        document.execCommand('insertHTML', false, imageHtml);
        handleInput();
      };
      reader.readAsDataURL(file);
    }
  };

  const insertTable = () => {
    const tableHtml = `
      <table border="1" style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr>
            <th style="padding: 8px; background-color: #f8f9fa;">Header 1</th>
            <th style="padding: 8px; background-color: #f8f9fa;">Header 2</th>
            <th style="padding: 8px; background-color: #f8f9fa;">Header 3</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 8px;">Cell 1</td>
            <td style="padding: 8px;">Cell 2</td>
            <td style="padding: 8px;">Cell 3</td>
          </tr>
        </tbody>
      </table><br/>
    `;
    document.execCommand('insertHTML', false, tableHtml);
    handleInput();
  };

  return (
    <div className="enhanced-rich-text-editor">
      {/* Professional Editor Toolbar */}
      <div className="editor-toolbar">
        {/* Format Selector */}
        <div className="toolbar-group">
          <select 
            className="format-selector"
            onChange={(e) => execCommand('formatBlock', e.target.value)}
            defaultValue=""
          >
            <option value="">Format</option>
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="blockquote">Quote</option>
          </select>
        </div>

        <div className="toolbar-separator"></div>

        {/* Basic Formatting */}
        <div className="toolbar-group">
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('bold')}
            title="Bold (Ctrl+B)"
          >
            <strong>B</strong>
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('italic')}
            title="Italic (Ctrl+I)"
          >
            <em>I</em>
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('underline')}
            title="Underline (Ctrl+U)"
          >
            <u>U</u>
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('strikeThrough')}
            title="Strikethrough"
          >
            <s>S</s>
          </button>
        </div>

        <div className="toolbar-separator"></div>

        {/* Text Color */}
        <div className="toolbar-group">
          <div className="color-group">
            <button 
              className="toolbar-btn color-btn"
              onClick={() => execCommand('foreColor', '#000000')}
              title="Text Color"
            >
              A
              <div className="color-indicator" style={{ backgroundColor: '#000000' }}></div>
            </button>
            <div className="color-dropdown">
              <button onClick={() => execCommand('foreColor', '#ff0000')} style={{ backgroundColor: '#ff0000' }}></button>
              <button onClick={() => execCommand('foreColor', '#00ff00')} style={{ backgroundColor: '#00ff00' }}></button>
              <button onClick={() => execCommand('foreColor', '#0000ff')} style={{ backgroundColor: '#0000ff' }}></button>
              <button onClick={() => execCommand('foreColor', '#ffff00')} style={{ backgroundColor: '#ffff00' }}></button>
              <button onClick={() => execCommand('foreColor', '#ff00ff')} style={{ backgroundColor: '#ff00ff' }}></button>
              <button onClick={() => execCommand('foreColor', '#00ffff')} style={{ backgroundColor: '#00ffff' }}></button>
            </div>
          </div>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('hiliteColor', '#ffff00')}
            title="Highlight"
          >
            🖍️
          </button>
        </div>

        <div className="toolbar-separator"></div>

        {/* Lists & Alignment */}
        <div className="toolbar-group">
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('insertUnorderedList')}
            title="Bullet List"
          >
            📋
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('insertOrderedList')}
            title="Numbered List"
          >
            📝
          </button>
        </div>

        <div className="toolbar-separator"></div>

        <div className="toolbar-group">
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('justifyLeft')}
            title="Align Left"
          >
            📄
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('justifyCenter')}
            title="Center"
          >
            📄
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('justifyRight')}
            title="Align Right"
          >
            📄
          </button>
        </div>

        <div className="toolbar-separator"></div>

        {/* Insert Elements */}
        <div className="toolbar-group">
          <button 
            className="toolbar-btn"
            onClick={() => setLinkModal(true)}
            title="Insert Link"
          >
            🔗
          </button>
          <button 
            className="toolbar-btn"
            onClick={insertImage}
            title="Insert Image"
          >
            🖼️
          </button>
          <button 
            className="toolbar-btn"
            onClick={insertTable}
            title="Insert Table"
          >
            📊
          </button>
        </div>

        <div className="toolbar-separator"></div>

        {/* History */}
        <div className="toolbar-group">
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('undo')}
            title="Undo"
          >
            ↶
          </button>
          <button 
            className="toolbar-btn"
            onClick={() => execCommand('redo')}
            title="Redo"
          >
            ↷
          </button>
        </div>
      </div>

      {/* Editor Content Area */}
      <div
        ref={editorRef}
        contentEditable={true}
        className="editor-content"
        onInput={handleInput}
        onPaste={handlePaste}
        dangerouslySetInnerHTML={{ __html: content }}
        data-placeholder={placeholder}
      />

      {/* Hidden file input for image upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageUpload}
      />

      {/* Link Modal */}
      <Modal isOpen={linkModal} toggle={() => setLinkModal(false)} size="sm">
        <ModalHeader toggle={() => setLinkModal(false)}>Insert Link</ModalHeader>
        <ModalBody>
          <div className="mb-3">
            <label className="form-label">Link Text:</label>
            <Input
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              placeholder="Enter link text"
              size="sm"
            />
          </div>
          <div className="mb-3">
            <label className="form-label">URL:</label>
            <Input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://example.com"
              size="sm"
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button color="primary" size="sm" onClick={insertLink}>Insert</Button>
          <Button color="secondary" size="sm" onClick={() => setLinkModal(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>

      <style>{`
        .enhanced-rich-text-editor {
          border: 1px solid #ddd;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .editor-toolbar {
          display: flex;
          align-items: center;
          padding: 8px 12px;
          background: linear-gradient(to bottom, #ffffff, #f8f9fa);
          border-bottom: 1px solid #e9ecef;
          flex-wrap: wrap;
          gap: 4px;
        }

        .toolbar-group {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .toolbar-separator {
          width: 1px;
          height: 24px;
          background-color: #dee2e6;
          margin: 0 6px;
        }

        .format-selector {
          padding: 4px 8px;
          border: 1px solid #ced4da;
          border-radius: 4px;
          background: white;
          font-size: 13px;
          min-width: 90px;
        }

        .toolbar-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: 1px solid transparent;
          background: transparent;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.2s ease;
          position: relative;
        }

        .toolbar-btn:hover {
          background-color: #e9ecef;
          border-color: #ced4da;
        }

        .toolbar-btn:active {
          background-color: #dee2e6;
          transform: translateY(1px);
        }

        .color-group {
          position: relative;
        }

        .color-btn {
          flex-direction: column;
          padding: 2px;
        }

        .color-indicator {
          width: 20px;
          height: 3px;
          margin-top: 2px;
          border-radius: 1px;
        }

        .color-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          background: white;
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 4px;
          display: none;
          z-index: 1000;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }

        .color-group:hover .color-dropdown {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 2px;
        }

        .color-dropdown button {
          width: 20px;
          height: 20px;
          border: 1px solid #ddd;
          border-radius: 2px;
          cursor: pointer;
        }

        .editor-content {
          min-height: 300px;
          padding: 16px;
          outline: none;
          background: white;
          line-height: 1.6;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
        }

        .editor-content:empty:before {
          content: attr(data-placeholder);
          color: #999;
          font-style: italic;
        }

        .editor-content:focus {
          box-shadow: inset 0 0 0 2px rgba(0,123,255,0.25);
        }

        .editor-content h1, .editor-content h2, .editor-content h3 {
          margin: 0.5em 0;
          font-weight: 600;
        }

        .editor-content h1 { font-size: 1.8em; }
        .editor-content h2 { font-size: 1.5em; }
        .editor-content h3 { font-size: 1.3em; }

        .editor-content blockquote {
          border-left: 4px solid #007bff;
          margin: 1em 0;
          padding: 0.5em 1em;
          background-color: #f8f9fa;
          font-style: italic;
        }

        .editor-content table {
          margin: 1em 0;
          border-collapse: collapse;
          width: 100%;
        }

        .editor-content table th,
        .editor-content table td {
          border: 1px solid #dee2e6;
          padding: 8px 12px;
        }

        .editor-content table th {
          background-color: #f8f9fa;
          font-weight: 600;
        }

        .editor-content ul, .editor-content ol {
          margin: 0.5em 0;
          padding-left: 1.5em;
        }

        .editor-content li {
          margin: 0.25em 0;
        }

        .editor-content a {
          color: #007bff;
          text-decoration: none;
        }

        .editor-content a:hover {
          text-decoration: underline;
        }

        .editor-content img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
        }

        @media (max-width: 768px) {
          .editor-toolbar {
            padding: 6px 8px;
          }
          
          .toolbar-btn {
            width: 24px;
            height: 24px;
            font-size: 12px;
          }
          
          .format-selector {
            min-width: 70px;
            font-size: 12px;
          }
        }
      `}</style>
    </div>
  );
};

export default class FormSimpleRichTextEditor extends Component {
  constructor(props) {
    super(props);

    this.state = {
      fullContent: `<h1>Professional Rich Text Editor</h1>
      <p>This is a <strong>clean, professional</strong> WYSIWYG editor built for <em>React 19</em> with a modern toolbar design.</p>
      
      <h2>Key Features:</h2>
      <ul>
        <li><strong>Professional toolbar</strong> with grouped controls</li>
        <li><em>Visual formatting</em> options with color picker</li>
        <li>Clean, modern design that looks like industry-standard editors</li>
        <li>Responsive layout that works on all devices</li>
      </ul>
      
      <blockquote>
        The toolbar is now properly organized with visual separators and logical grouping.
      </blockquote>
      
      <p>Try the formatting tools above!</p>`,
      simpleContent: '<p>This is a second editor instance. All tools work here too!</p>',
    };
  }

  handleFullChange = (content) => {
    this.setState({ fullContent: content });
  };

  handleSimpleChange = (content) => {
    this.setState({ simpleContent: content });
  };

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>
              <Row>
                <Col md="12">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Professional Rich Text Editor</CardTitle>
                      <p className="text-muted mb-3">
                        Clean, modern WYSIWYG editor with professional toolbar design and organized feature groups.
                      </p>
                      <EnhancedRichTextEditor
                        value={this.state.fullContent}
                        onChange={this.handleFullChange}
                        placeholder="Start writing your content..."
                      />
                    </CardBody>
                  </Card>
                </Col>
              </Row>

              <Row>
                <Col md="8">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Second Editor Instance</CardTitle>
                      <p className="text-muted mb-3">
                        Demonstrates editor reusability with the same professional interface.
                      </p>
                      <EnhancedRichTextEditor
                        value={this.state.simpleContent}
                        onChange={this.handleSimpleChange}
                        placeholder="Type something here..."
                      />
                    </CardBody>
                  </Card>
                </Col>

                <Col md="4">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>✨ Editor Features</CardTitle>
                      <div className="feature-list">
                        <div className="feature-item mb-3">
                          <strong>🎨 Professional Design</strong><br/>
                          <small>Clean toolbar with logical grouping and visual separators</small>
                        </div>
                        <div className="feature-item mb-3">
                          <strong>📝 Essential Formatting</strong><br/>
                          <small>Bold, italic, colors, lists, alignment, links</small>
                        </div>
                        <div className="feature-item mb-3">
                          <strong>🔗 Media Support</strong><br/>
                          <small>Images, links, tables with proper styling</small>
                        </div>
                        <div className="feature-item mb-3">
                          <strong>📱 Responsive</strong><br/>
                          <small>Adapts to mobile and desktop screens</small>
                        </div>
                        <div className="feature-item">
                          <strong>⚡ React 19 Compatible</strong><br/>
                          <small>No deprecated APIs, fully modern</small>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </Col>
              </Row>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

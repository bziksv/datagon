import React, { Fragment, useState } from "react";
import {
  Row,
  Col,
  Card,
  CardBody,
  CardTitle,
  InputGroup,
  Input,
} from "reactstrap";

import { faCalendarAlt, faPhone, faCreditCard, faIdCard } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

// CSS to fix double X button issue
const inputMaskStyles = `
  .input-mask-fix::-ms-clear,
  .input-mask-fix::-ms-reveal {
    display: none;
    width: 0;
    height: 0;
  }
  
  .input-mask-fix::-webkit-search-decoration,
  .input-mask-fix::-webkit-search-cancel-button,
  .input-mask-fix::-webkit-search-results-button,
  .input-mask-fix::-webkit-search-results-decoration {
    display: none;
  }
  
  .input-mask-fix::-webkit-inner-spin-button,
  .input-mask-fix::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
`;

// React 19 compatible Input Mask component
const InputMask = ({ mask, value, onChange, placeholder, className, defaultValue, style, ...props }) => {
  const [inputValue, setInputValue] = useState(defaultValue || value || '');

  // Inject styles only once
  React.useEffect(() => {
    if (!document.querySelector('#input-mask-styles')) {
      const styleSheet = document.createElement('style');
      styleSheet.id = 'input-mask-styles';
      styleSheet.textContent = inputMaskStyles;
      document.head.appendChild(styleSheet);
    }
  }, []);

  const applyMask = (inputVal, maskPattern) => {
    if (!maskPattern) return inputVal;
    
    let masked = '';
    let inputIndex = 0;
    
    for (let i = 0; i < maskPattern.length && inputIndex < inputVal.length; i++) {
      const maskChar = maskPattern[i];
      const inputChar = inputVal[inputIndex];
      
      if (maskChar === '9') {
        if (/\d/.test(inputChar)) {
          masked += inputChar;
          inputIndex++;
        } else {
          inputIndex++;
          i--; // Stay on the same mask position
        }
      } else if (maskChar === 'A') {
        if (/[A-Za-z]/.test(inputChar)) {
          masked += inputChar.toUpperCase();
          inputIndex++;
        } else {
          inputIndex++;
          i--; // Stay on the same mask position
        }
      } else if (maskChar === 'a') {
        if (/[A-Za-z]/.test(inputChar)) {
          masked += inputChar.toLowerCase();
          inputIndex++;
        } else {
          inputIndex++;
          i--; // Stay on the same mask position
        }
      } else if (maskChar === '*') {
        masked += inputChar;
        inputIndex++;
      } else {
        // Fixed character in mask
        masked += maskChar;
      }
    }
    
    return masked;
  };

  const handleChange = (e) => {
    const rawValue = e.target.value.replace(/[^\w]/g, ''); // Remove non-alphanumeric
    const maskedValue = applyMask(rawValue, mask);
    
    setInputValue(maskedValue);
    
    if (onChange) {
      const syntheticEvent = {
        ...e,
        target: { ...e.target, value: maskedValue }
      };
      onChange(syntheticEvent);
    }
  };

  // Fix double X button issue by hiding browser default clear buttons
  const inputStyle = {
    ...style,
    // Hide IE/Edge clear button
    '::-ms-clear': { display: 'none', width: 0, height: 0 },
    '::-ms-reveal': { display: 'none', width: 0, height: 0 },
    // Hide Safari clear button
    '::-webkit-search-decoration': { display: 'none' },
    '::-webkit-search-cancel-button': { display: 'none' },
    '::-webkit-search-results-button': { display: 'none' },
    '::-webkit-search-results-decoration': { display: 'none' }
  };

  return (
    <Input
      {...props}
      value={inputValue}
      onChange={handleChange}
      placeholder={placeholder}
      className={`${className} input-mask-fix`}
      style={style}
      // Additional props to prevent browser clear buttons
      autoComplete="off"
      spellCheck="false"
      type="text"
    />
  );
};

// Credit card mask detector
const CreditCardInput = () => {
  const [cardValue, setCardValue] = useState('');
  const [cardMask, setCardMask] = useState('9999-9999-9999-9999');

  const handleCardChange = (e) => {
    const value = e.target.value.replace(/\D/g, ''); // Remove non-digits
    setCardValue(value);
    
    // Detect card type and adjust mask
    if (/^3[47]/.test(value)) {
      setCardMask('9999-999999-99999'); // Amex
    } else {
      setCardMask('9999-9999-9999-9999'); // Visa/MC/etc
    }
  };

  const applyCardMask = (value, mask) => {
    let masked = '';
    let valueIndex = 0;
    
    for (let i = 0; i < mask.length && valueIndex < value.length; i++) {
      if (mask[i] === '9') {
        masked += value[valueIndex];
        valueIndex++;
      } else {
        masked += mask[i];
      }
    }
    
    return masked;
  };

  const maskedValue = applyCardMask(cardValue, cardMask);

  return (
    <Input
      value={maskedValue}
      onChange={handleCardChange}
      placeholder="Enter credit card number"
      className="form-control input-mask-fix"
      autoComplete="off"
      spellCheck="false"
      type="text"
    />
  );
};

class FormInputMaskExample extends React.Component {
  state = {
    phoneValue1: '',
    phoneValue2: '',
    dateValue1: '27-10-2018',
    dateValue2: '',
    ssnValue: '',
    zipValue: '',
  };

  render() {
    return (
      <Fragment>
        <Row>
          <Col md="6">
            <Card className="main-card mb-3">
              <CardBody>
                <CardTitle>📞 Phone Numbers</CardTitle>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faPhone} />
                  </div>
                  <InputMask
                    mask="+49 99 999 99"
                    placeholder="+49 12 345 67"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faPhone} />
                  </div>
                  <InputMask
                    mask="+7 (999) 999-99-99"
                    placeholder="+7 (123) 456-78-90"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup>
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faPhone} />
                  </div>
                  <InputMask
                    mask="(999) 999-9999"
                    placeholder="(123) 456-7890"
                    className="form-control"
                  />
                </InputGroup>
              </CardBody>
            </Card>
          </Col>
          
          <Col md="6">
            <Card className="main-card mb-3">
              <CardBody>
                <CardTitle>📅 Dates</CardTitle>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faCalendarAlt} />
                  </div>
                  <InputMask
                    mask="99-99-9999"
                    defaultValue="27-10-2018"
                    placeholder="DD-MM-YYYY"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faCalendarAlt} />
                  </div>
                  <InputMask
                    mask="99/99/9999"
                    placeholder="MM/DD/YYYY"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup>
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faCalendarAlt} />
                  </div>
                  <InputMask
                    mask="9999-99-99"
                    placeholder="YYYY-MM-DD"
                    className="form-control"
                  />
                </InputGroup>
              </CardBody>
            </Card>
          </Col>

          <Col md="6">
            <Card className="main-card mb-3">
              <CardBody>
                <CardTitle>💳 Credit Card</CardTitle>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faCreditCard} />
                  </div>
                  <CreditCardInput />
                </InputGroup>
                <small className="text-muted">
                  • Try entering 3456... for American Express format<br/>
                  • Other numbers use standard 16-digit format
                </small>
              </CardBody>
            </Card>
          </Col>

          <Col md="6">
            <Card className="main-card mb-3">
              <CardBody>
                <CardTitle>🆔 Identification</CardTitle>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faIdCard} />
                  </div>
                  <InputMask
                    mask="999-99-9999"
                    placeholder="SSN: 123-45-6789"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup className="mb-3">
                  <div className="input-group-text">
                    <FontAwesomeIcon icon={faIdCard} />
                  </div>
                  <InputMask
                    mask="99999-9999"
                    placeholder="ZIP+4: 12345-6789"
                    className="form-control"
                  />
                </InputGroup>
                <InputGroup>
                  <div className="input-group-text">
                    📋
                  </div>
                  <InputMask
                    mask="AAA-999"
                    placeholder="License: ABC-123"
                    className="form-control"
                  />
                </InputGroup>
              </CardBody>
            </Card>
          </Col>
        </Row>

        <Row>
          <Col md="12">
            <Card className="main-card mb-3">
              <CardBody>
                <CardTitle>✨ Input Mask Features</CardTitle>
                <Row>
                  <Col md="3">
                    <div className="feature-box text-center p-3 border rounded">
                      <div className="feature-icon mb-2">📱</div>
                      <h6>React 19 Compatible</h6>
                      <small>No deprecated APIs used</small>
                    </div>
                  </Col>
                  <Col md="3">
                    <div className="feature-box text-center p-3 border rounded">
                      <div className="feature-icon mb-2">🎭</div>
                      <h6>Smart Masking</h6>
                      <small>Automatic format detection</small>
                    </div>
                  </Col>
                  <Col md="3">
                    <div className="feature-box text-center p-3 border rounded">
                      <div className="feature-icon mb-2">⚡</div>
                      <h6>Lightweight</h6>
                      <small>No external dependencies</small>
                    </div>
                  </Col>
                  <Col md="3">
                    <div className="feature-box text-center p-3 border rounded">
                      <div className="feature-icon mb-2">🔧</div>
                      <h6>Customizable</h6>
                      <small>Easy to extend patterns</small>
                    </div>
                  </Col>
                </Row>
                
                <div className="mt-4">
                  <h6>Mask Pattern Guide:</h6>
                  <ul className="list-unstyled">
                    <li><code>9</code> - Numeric digit (0-9)</li>
                    <li><code>A</code> - Alphabetic character (A-Z, converted to uppercase)</li>
                    <li><code>a</code> - Alphabetic character (a-z, converted to lowercase)</li>
                    <li><code>*</code> - Any character</li>
                    <li><code>-,(,),/,:</code> - Fixed characters in the mask</li>
                  </ul>
                </div>
              </CardBody>
            </Card>
          </Col>
        </Row>
      </Fragment>
    );
  }
}

export default FormInputMaskExample;

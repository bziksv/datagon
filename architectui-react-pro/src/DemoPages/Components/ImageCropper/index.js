import React, { Component, Fragment, useState, useCallback } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";

import { Row, Col, Card, CardBody, CardTitle, Button } from "reactstrap";
import Cropper from "react-easy-crop";
import 'react-easy-crop/react-easy-crop.css';

import PageTitle from "../../../Layout/AppMain/PageTitle";

import DemoImg from "../../../assets/utils/images/originals/fence-small.jpg";

// Helper function to create image from URL
const createImage = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (error) => reject(error));
    image.setAttribute('crossOrigin', 'anonymous');
    image.src = url;
  });

// Helper function to get cropped image
const getCroppedImg = async (imageSrc, pixelCrop) => {
  const image = await createImage(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(URL.createObjectURL(blob));
    }, 'image/jpeg');
  });
};

// Functional component for easy crop
const EasyCrop = ({ imageSrc, onCropComplete, aspect = 4 / 3 }) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  const onCropCompleteCallback = useCallback((croppedArea, croppedAreaPixels) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleCrop = useCallback(async () => {
    if (croppedAreaPixels) {
      const croppedImage = await getCroppedImg(imageSrc, croppedAreaPixels);
      onCropComplete(croppedImage);
    }
  }, [imageSrc, croppedAreaPixels, onCropComplete]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '400px' }}>
      <Cropper
        image={imageSrc}
        crop={crop}
        zoom={zoom}
        aspect={aspect}
        onCropChange={setCrop}
        onCropComplete={onCropCompleteCallback}
        onZoomChange={setZoom}
      />
      <div style={{ position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        <Button color="primary" onClick={handleCrop}>
          Crop Selection
        </Button>
      </div>
    </div>
  );
};

class ImageCropExample extends Component {
  constructor(props) {
    super(props);
    this.state = {
      imgSrc: DemoImg,
      cropResult: null,
      cropResult2: null,
    };
  }

  handleCropComplete = (croppedImage) => {
    this.setState({
      cropResult: croppedImage,
    });
  };

  handleCropComplete2 = (croppedImage) => {
    this.setState({
      cropResult2: croppedImage,
    });
  };

  render() {
    return (
      <Fragment>
        <PageTitle heading="Image Crop"
          subheading="You can easily crop and edit images with this React plugin."
          icon="pe-7s-signal icon-gradient bg-malibu-beach"/>
          <TransitionGroup>
            <CSSTransition component="div" classNames="TabsAnimation" appear={true}
              timeout={1500} enter={false} exit={false}>
              <Row>
                <Col lg="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Basic</CardTitle>
                      <EasyCrop
                        imageSrc={this.state.imgSrc}
                        onCropComplete={this.handleCropComplete}
                        aspect={4 / 3}
                      />
                      {this.state.cropResult && (
                        <div className="mt-3">
                          <div className="divider" />
                          <div>
                            <h6>Cropped Result</h6>
                          </div>
                          <img className="after-img rounded" src={this.state.cropResult} alt="" style={{ maxWidth: '100%', height: 'auto' }} />
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </Col>
                <Col lg="6">
                  <Card className="main-card mb-3">
                    <CardBody>
                      <CardTitle>Predefined Aspect Ratio (16:9)</CardTitle>
                      <EasyCrop
                        imageSrc={this.state.imgSrc}
                        onCropComplete={this.handleCropComplete2}
                        aspect={16 / 9}
                      />
                      {this.state.cropResult2 && (
                        <div className="mt-3">
                          <div className="divider" />
                          <div>
                            <h6>Cropped Result</h6>
                          </div>
                          <img className="after-img rounded" src={this.state.cropResult2} alt="" style={{ maxWidth: '100%', height: 'auto' }} />
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </Col>
              </Row>
            </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

export default ImageCropExample;

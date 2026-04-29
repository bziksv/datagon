import React, { useEffect, useMemo, useRef, useState } from 'react';
import { connect } from 'react-redux';
import { Button, UncontrolledTooltip, ListGroup, ListGroupItem, Row, Col } from 'reactstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSlidersH } from '@fortawesome/free-solid-svg-icons';
import CustomScrollbar from '../../components/CustomScrollbar';

// Import theme actions
import {
  setEnableBackgroundImage,
  setEnableFixedHeader,
  setEnableHeaderShadow,
  setEnableSidebarShadow,
  setEnablePageTitleIcon,
  setEnablePageTitleSubheading,
  setEnableFixedSidebar,
  setEnableFixedFooter,
  setBackgroundColor,
  setHeaderBackgroundColor,
  setColorScheme,
  setBackgroundImageOpacity,
  setBackgroundImage,
} from '../../reducers/ThemeOptions';

// Import sidebar background images
import sidebar1 from '../../assets/utils/images/sidebar/city1.jpg';
import sidebar2 from '../../assets/utils/images/sidebar/city2.jpg';
import sidebar3 from '../../assets/utils/images/sidebar/city3.jpg';
import sidebar4 from '../../assets/utils/images/sidebar/city4.jpg';
import sidebar5 from '../../assets/utils/images/sidebar/city5.jpg';
import sidebar6 from '../../assets/utils/images/sidebar/abstract1.jpg';
import sidebar7 from '../../assets/utils/images/sidebar/abstract2.jpg';
import sidebar8 from '../../assets/utils/images/sidebar/abstract3.jpg';
import sidebar9 from '../../assets/utils/images/sidebar/abstract4.jpg';
import sidebar10 from '../../assets/utils/images/sidebar/abstract5.jpg';
import sidebar11 from '../../assets/utils/images/sidebar/abstract6.jpg';
import sidebar12 from '../../assets/utils/images/sidebar/abstract7.jpg';
import sidebar13 from '../../assets/utils/images/sidebar/abstract8.jpg';
import sidebar14 from '../../assets/utils/images/sidebar/abstract9.jpg';
import sidebar15 from '../../assets/utils/images/sidebar/abstract10.jpg';

const ThemeOptions = (props) => {
    const embeddedInHeader = Boolean(props.embeddedInHeader);
    const sidebarStateStorageKey = useMemo(() => {
        const user = String(window.localStorage.getItem('currentUser') || 'guest').trim() || 'guest';
        return `datagon_theme_options_open_v1:${user}:${embeddedInHeader ? 'header' : 'floating'}`;
    }, [embeddedInHeader]);
    const [showing, setShowing] = useState(() => {
        try {
            const saved = window.localStorage.getItem(sidebarStateStorageKey);
            return saved === '1';
        } catch (_) {
            return false;
        }
    });
    const hydratedRef = useRef(false);

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(sidebarStateStorageKey);
            if (saved === '1') setShowing(true);
            else if (saved === '0') setShowing(false);
        } catch (_) {}
        hydratedRef.current = true;
    }, [sidebarStateStorageKey]);

    useEffect(() => {
        if (!hydratedRef.current) return;
        try {
            window.localStorage.setItem(sidebarStateStorageKey, showing ? '1' : '0');
        } catch (_) {}
    }, [showing, sidebarStateStorageKey]);

    const toggleShowing = () => {
        setShowing((prev) => !prev);
    };

    const backgroundImages = [
        { id: 1, img: sidebar1, name: 'Город 1' },
        { id: 2, img: sidebar2, name: 'Город 2' },
        { id: 3, img: sidebar3, name: 'Город 3' },
        { id: 4, img: sidebar4, name: 'Город 4' },
        { id: 5, img: sidebar5, name: 'Город 5' },
        { id: 6, img: sidebar6, name: 'Абстракция 1' },
        { id: 7, img: sidebar7, name: 'Абстракция 2' },
        { id: 8, img: sidebar8, name: 'Абстракция 3' },
        { id: 9, img: sidebar9, name: 'Абстракция 4' },
        { id: 10, img: sidebar10, name: 'Абстракция 5' },
        { id: 11, img: sidebar11, name: 'Абстракция 6' },
        { id: 12, img: sidebar12, name: 'Абстракция 7' },
        { id: 13, img: sidebar13, name: 'Абстракция 8' },
        { id: 14, img: sidebar14, name: 'Абстракция 9' },
        { id: 15, img: sidebar15, name: 'Абстракция 10' },
    ];

    const backgroundImageOpacities = [
        { id: 1, name: 'opacity-01', label: '10%' },
        { id: 2, name: 'opacity-02', label: '20%' },
        { id: 3, name: 'opacity-03', label: '30%' },
        { id: 4, name: 'opacity-04', label: '40%' },
        { id: 5, name: 'opacity-05', label: '50%' },
        { id: 6, name: 'opacity-06', label: '60%' },
        { id: 7, name: 'opacity-07', label: '70%' },
        { id: 8, name: 'opacity-08', label: '80%' },
    ];

    // Comprehensive sidebar background colors
    const sidebarColors = [
        { id: 1, name: 'sidebar-text-light', color: '#3f6ad8', label: 'Светлый текст' },
        { id: 2, name: 'sidebar-text-dark', color: '#ffffff', label: 'Темный текст' },
        { id: 3, name: 'bg-warm-flame', color: '#ff9a9e', label: 'Теплое пламя' },
        { id: 4, name: 'bg-night-fade', color: '#a18cd1', label: 'Ночное затухание' },
        { id: 5, name: 'bg-sunny-morning', color: '#f6d365', label: 'Солнечное утро' },
        { id: 6, name: 'bg-tempting-azure', color: '#84fab0', label: 'Лазурный соблазн' },
        { id: 7, name: 'bg-amy-crisp', color: '#a6c0fe', label: 'Свежесть Amy' },
        { id: 8, name: 'bg-heavy-rain', color: '#cfd9df', label: 'Сильный дождь' },
        { id: 9, name: 'bg-mean-fruit', color: '#fccb90', label: 'Сочный фрукт' },
        { id: 10, name: 'bg-malibu-beach', color: '#4facfe', label: 'Пляж Малибу' },
        { id: 11, name: 'bg-deep-blue', color: '#e0c3fc', label: 'Глубокий синий' },
        { id: 12, name: 'bg-ripe-malin', color: '#f093fb', label: 'Спелая малина' },
        { id: 13, name: 'bg-arielle-smile', color: '#16d9e3', label: 'Улыбка Ариэль' },
        { id: 14, name: 'bg-plum-plate', color: '#667eea', label: 'Сливовый тон' },
        { id: 15, name: 'bg-happy-fisher', color: '#89f7fe', label: 'Счастливый рыбак' },
        { id: 16, name: 'bg-happy-itmeo', color: '#2af598', label: 'Счастливый Itmeo' },
        { id: 17, name: 'bg-mixed-hopes', color: '#c471f5', label: 'Смешанные надежды' },
        { id: 18, name: 'bg-strong-bliss', color: '#f78ca0', label: 'Яркое блаженство' },
        { id: 19, name: 'bg-grow-early', color: '#0ba360', label: 'Ранний рост' },
        { id: 20, name: 'bg-love-kiss', color: '#ff0844', label: 'Поцелуй любви' },
        { id: 21, name: 'bg-premium-dark', color: '#434343', label: 'Премиум темный' },
        { id: 22, name: 'bg-happy-green', color: '#00b09b', label: 'Счастливый зеленый' },
        { id: 23, name: 'bg-vicious-stance', color: '#29323c', label: 'Суровый стиль' },
        { id: 24, name: 'bg-midnight-bloom', color: '#2b5876', label: 'Полуночный цвет' },
        { id: 25, name: 'bg-night-sky', color: '#1e3c72', label: 'Ночное небо' },
        { id: 26, name: 'bg-slick-carbon', color: '#323232', label: 'Гладкий карбон' },
        { id: 27, name: 'bg-royal', color: '#141e30', label: 'Королевский' },
        { id: 28, name: 'bg-asteroid', color: '#0f2027', label: 'Астероид' },
    ];

    // Comprehensive header background colors
    const headerColors = [
        { id: 1, name: 'header-text-light', color: '#3f6ad8', label: 'Светлый текст' },
        { id: 2, name: 'header-text-dark', color: '#ffffff', label: 'Темный текст' },
        { id: 3, name: 'bg-warm-flame', color: '#ff9a9e', label: 'Теплое пламя' },
        { id: 4, name: 'bg-night-fade', color: '#a18cd1', label: 'Ночное затухание' },
        { id: 5, name: 'bg-sunny-morning', color: '#f6d365', label: 'Солнечное утро' },
        { id: 6, name: 'bg-tempting-azure', color: '#84fab0', label: 'Лазурный соблазн' },
        { id: 7, name: 'bg-amy-crisp', color: '#a6c0fe', label: 'Свежесть Amy' },
        { id: 8, name: 'bg-heavy-rain', color: '#cfd9df', label: 'Сильный дождь' },
        { id: 9, name: 'bg-mean-fruit', color: '#fccb90', label: 'Сочный фрукт' },
        { id: 10, name: 'bg-malibu-beach', color: '#4facfe', label: 'Пляж Малибу' },
        { id: 11, name: 'bg-deep-blue', color: '#e0c3fc', label: 'Глубокий синий' },
        { id: 12, name: 'bg-ripe-malin', color: '#f093fb', label: 'Спелая малина' },
        { id: 13, name: 'bg-arielle-smile', color: '#16d9e3', label: 'Улыбка Ариэль' },
        { id: 14, name: 'bg-plum-plate', color: '#667eea', label: 'Сливовый тон' },
        { id: 15, name: 'bg-happy-fisher', color: '#89f7fe', label: 'Счастливый рыбак' },
        { id: 16, name: 'bg-happy-itmeo', color: '#2af598', label: 'Счастливый Itmeo' },
        { id: 17, name: 'bg-mixed-hopes', color: '#c471f5', label: 'Смешанные надежды' },
        { id: 18, name: 'bg-strong-bliss', color: '#f78ca0', label: 'Яркое блаженство' },
        { id: 19, name: 'bg-grow-early', color: '#0ba360', label: 'Ранний рост' },
        { id: 20, name: 'bg-love-kiss', color: '#ff0844', label: 'Поцелуй любви' },
        { id: 21, name: 'bg-premium-dark', color: '#434343', label: 'Премиум темный' },
        { id: 22, name: 'bg-happy-green', color: '#00b09b', label: 'Счастливый зеленый' },
        { id: 23, name: 'bg-vicious-stance', color: '#29323c', label: 'Суровый стиль' },
        { id: 24, name: 'bg-midnight-bloom', color: '#2b5876', label: 'Полуночный цвет' },
        { id: 25, name: 'bg-night-sky', color: '#1e3c72', label: 'Ночное небо' },
        { id: 26, name: 'bg-slick-carbon', color: '#323232', label: 'Гладкий карбон' },
        { id: 27, name: 'bg-royal', color: '#141e30', label: 'Королевский' },
        { id: 28, name: 'bg-asteroid', color: '#0f2027', label: 'Астероид' },
    ];

    // Only working color schemes - based on actual SCSS theme files
    const colorSchemes = [
        { id: 1, name: 'white', color: '#ffffff', label: 'Светлая тема' },
        { id: 2, name: 'gray', color: '#868e96', label: 'Серая тема' },
    ];

    // Safe prop access with defaults
    const safeProps = {
        enableBackgroundImage: Boolean(props.enableBackgroundImage),
        enableFixedHeader: props.enableFixedHeader !== undefined ? Boolean(props.enableFixedHeader) : true,
        enableHeaderShadow: props.enableHeaderShadow !== undefined ? Boolean(props.enableHeaderShadow) : true,
        enableSidebarShadow: props.enableSidebarShadow !== undefined ? Boolean(props.enableSidebarShadow) : true,
        enablePageTitleIcon: props.enablePageTitleIcon !== undefined ? Boolean(props.enablePageTitleIcon) : true,
        enablePageTitleSubheading: props.enablePageTitleSubheading !== undefined ? Boolean(props.enablePageTitleSubheading) : true,
        enableFixedSidebar: props.enableFixedSidebar !== undefined ? Boolean(props.enableFixedSidebar) : true,
        enableFixedFooter: props.enableFixedFooter !== undefined ? Boolean(props.enableFixedFooter) : true,
        backgroundColor: props.backgroundColor || '',
        headerBackgroundColor: props.headerBackgroundColor || '',
        colorScheme: props.colorScheme || 'white',
        backgroundImageOpacity: props.backgroundImageOpacity || 'opacity-06',
        backgroundImage: props.backgroundImage || sidebar1,
    };

    // Error-safe action handlers
    const handleAction = (actionName, actionFn, value) => {
        try {
            if (typeof actionFn === 'function') {
                actionFn(value);
            }
        } catch (error) {
            console.error(`Theme customizer error in ${actionName}:`, error);
        }
    };

    return (
        <div className={`ui-theme-settings ${embeddedInHeader ? 'ui-theme-settings--header' : ''} ${showing ? 'settings-open' : ''}`}>
            <Button
                className={`btn-open-options ${embeddedInHeader ? 'btn-open-options--header' : ''}`}
                id="TooltipDemo" 
                color={embeddedInHeader ? "link" : "warning"}
                onClick={toggleShowing}
            >
                <FontAwesomeIcon icon={faSlidersH} color={embeddedInHeader ? "#3f6ad8" : "#573a04"} fixedWidth={false} size={embeddedInHeader ? "lg" : "2x"}/>
            </Button>
            {!embeddedInHeader ? (
              <UncontrolledTooltip placement="left" target={'TooltipDemo'}>
                  Открыть настройки интерфейса
              </UncontrolledTooltip>
            ) : null}
            <div className="theme-settings__inner">
                {showing && (
                    <CustomScrollbar
                        style={{
                            height: embeddedInHeader ? 'calc(100vh - 90px)' : '100vh',
                            maxHeight: embeddedInHeader ? 'calc(100vh - 90px)' : '100vh',
                            overflowY: 'auto',
                            overflowX: 'hidden',
                        }}
                    >
                        <div className="theme-settings__options-wrapper">
                            <h3 className="themeoptions-heading">Параметры макета</h3>
                            <ListGroup>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Фиксированная шапка</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableFixedHeader}
                                            onChange={(e) => handleAction('setEnableFixedHeader', props.setEnableFixedHeader, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Тень шапки</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableHeaderShadow}
                                            onChange={(e) => handleAction('setEnableHeaderShadow', props.setEnableHeaderShadow, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Фиксированный сайдбар</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableFixedSidebar}
                                            onChange={(e) => handleAction('setEnableFixedSidebar', props.setEnableFixedSidebar, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Тень сайдбара</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableSidebarShadow}
                                            onChange={(e) => handleAction('setEnableSidebarShadow', props.setEnableSidebarShadow, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Фиксированный футер</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableFixedFooter}
                                            onChange={(e) => handleAction('setEnableFixedFooter', props.setEnableFixedFooter, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                            </ListGroup>

                            <h3 className="themeoptions-heading">Параметры заголовка страницы</h3>
                            <ListGroup>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Иконка заголовка</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enablePageTitleIcon}
                                            onChange={(e) => handleAction('setEnablePageTitleIcon', props.setEnablePageTitleIcon, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Подзаголовок страницы</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enablePageTitleSubheading}
                                            onChange={(e) => handleAction('setEnablePageTitleSubheading', props.setEnablePageTitleSubheading, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>
                            </ListGroup>

                            <h3 className="themeoptions-heading">Цветовые схемы</h3>
                            <ListGroup>
                                <ListGroupItem>
                                    <h5>Цветовая схема макета</h5>
                                    <div className="theme-settings-swatches">
                                        {colorSchemes.map((scheme) => (
                                            <div 
                                                key={scheme.id}
                                                className={`swatch-holder-lg ${safeProps.colorScheme === scheme.name ? 'active' : ''}`}
                                                style={{ backgroundColor: scheme.color, border: scheme.color === '#ffffff' ? '1px solid #dee2e6' : 'none' }}
                                                onClick={() => handleAction('setColorScheme', props.setColorScheme, scheme.name)}
                                                title={scheme.label}
                                            />
                                        ))}
                                    </div>
                                </ListGroupItem>
                            </ListGroup>

                            <h3 className="themeoptions-heading">Параметры сайдбара</h3>
                            <ListGroup>
                                <ListGroupItem className="d-flex justify-content-between align-items-center">
                                    <h5>Фоновое изображение сайдбара</h5>
                                    <label className="switch">
                                        <input
                                            type="checkbox"
                                            checked={safeProps.enableBackgroundImage}
                                            onChange={(e) => handleAction('setEnableBackgroundImage', props.setEnableBackgroundImage, e.target.checked)}
                                        />
                                        <span className="slider round"></span>
                                    </label>
                                </ListGroupItem>

                                {safeProps.enableBackgroundImage && (
                                    <>
                                        <ListGroupItem>
                                            <h5>Фоновые изображения</h5>
                                            <div className="theme-settings-swatches">
                                                <Row>
                                                    {backgroundImages.map((bg) => (
                                                        <Col key={bg.id} xs="4" className="mb-2">
                                                            <div 
                                                                className={`swatch-holder-img ${safeProps.backgroundImage === bg.img ? 'active' : ''}`}
                                                                onClick={() => handleAction('setBackgroundImage', props.setBackgroundImage, bg.img)}
                                                                title={bg.name}
                                                            >
                                                                <img src={bg.img} alt={bg.name} />
                                                            </div>
                                                        </Col>
                                                    ))}
                                                </Row>
                                            </div>
                                        </ListGroupItem>

                                        <ListGroupItem>
                                            <h5>Прозрачность фона</h5>
                                            <div className="theme-settings-swatches">
                                                {backgroundImageOpacities.map((opacity) => (
                                                    <Button
                                                        key={opacity.id}
                                                        size="sm"
                                                        className={`me-2 mb-2 ${safeProps.backgroundImageOpacity === opacity.name ? 'btn-primary' : 'btn-outline-primary'}`}
                                                        onClick={() => handleAction('setBackgroundImageOpacity', props.setBackgroundImageOpacity, opacity.name)}
                                                    >
                                                        {opacity.label}
                                                    </Button>
                                                ))}
                                            </div>
                                        </ListGroupItem>
                                    </>
                                )}

                                <ListGroupItem>
                                    <h5>Цвета сайдбара</h5>
                                    <div className="theme-settings-swatches">
                                        {sidebarColors.map((color) => (
                                            <div 
                                                key={color.id}
                                                className={`swatch-holder ${safeProps.backgroundColor === color.name ? 'active' : ''}`}
                                                style={{ backgroundColor: color.color }}
                                                onClick={() => handleAction('setBackgroundColor', props.setBackgroundColor, color.name)}
                                                title={color.label}
                                            />
                                        ))}
                                    </div>
                                </ListGroupItem>
                            </ListGroup>

                            <h3 className="themeoptions-heading">Параметры шапки</h3>
                            <ListGroup>
                                <ListGroupItem>
                                    <h5>Цвета шапки</h5>
                                    <div className="theme-settings-swatches">
                                        {headerColors.map((color) => (
                                            <div 
                                                key={color.id}
                                                className={`swatch-holder ${safeProps.headerBackgroundColor === color.name ? 'active' : ''}`}
                                                style={{ backgroundColor: color.color }}
                                                onClick={() => handleAction('setHeaderBackgroundColor', props.setHeaderBackgroundColor, color.name)}
                                                title={color.label}
                                            />
                                        ))}
                                    </div>
                                </ListGroupItem>
                            </ListGroup>
                        </div>
                    </CustomScrollbar>
                )}
            </div>
        </div>
    );
};

const mapStateToProps = (state) => ({
    enableBackgroundImage: state.ThemeOptions.enableBackgroundImage,
    enableFixedHeader: state.ThemeOptions.enableFixedHeader,
    enableHeaderShadow: state.ThemeOptions.enableHeaderShadow,
    enableSidebarShadow: state.ThemeOptions.enableSidebarShadow,
    enablePageTitleIcon: state.ThemeOptions.enablePageTitleIcon,
    enablePageTitleSubheading: state.ThemeOptions.enablePageTitleSubheading,
    enableFixedSidebar: state.ThemeOptions.enableFixedSidebar,
    enableFixedFooter: state.ThemeOptions.enableFixedFooter,
    backgroundColor: state.ThemeOptions.backgroundColor,
    headerBackgroundColor: state.ThemeOptions.headerBackgroundColor,
    colorScheme: state.ThemeOptions.colorScheme,
    backgroundImageOpacity: state.ThemeOptions.backgroundImageOpacity,
    backgroundImage: state.ThemeOptions.backgroundImage,
});

const mapDispatchToProps = {
    setEnableBackgroundImage,
    setEnableFixedHeader,
    setEnableHeaderShadow,
    setEnableSidebarShadow,
    setEnablePageTitleIcon,
    setEnablePageTitleSubheading,
    setEnableFixedSidebar,
    setEnableFixedFooter,
    setBackgroundColor,
    setHeaderBackgroundColor,
    setColorScheme,
    setBackgroundImageOpacity,
    setBackgroundImage,
};

export default connect(mapStateToProps, mapDispatchToProps)(ThemeOptions);
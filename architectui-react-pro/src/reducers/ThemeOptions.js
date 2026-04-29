import { createSlice } from '@reduxjs/toolkit';
import sideBar6 from '../assets/utils/images/sidebar/city1.jpg';

const CLOSED_SIDEBAR_STORAGE_KEY = 'datagon_closed_sidebar_v1';

const readClosedSidebarDefault = () => {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(CLOSED_SIDEBAR_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
};

const initialState = {
  backgroundColor: '',
  headerBackgroundColor: '',
  enableMobileMenuSmall: '',
  enableBackgroundImage: false,
  enableClosedSidebar: readClosedSidebarDefault(),
  enableFixedHeader: true,
  enableHeaderShadow: true,
  enableSidebarShadow: true,
  enableFixedFooter: true,
  enableFixedSidebar: true,
  colorScheme: 'white',
  backgroundImage: sideBar6,
  backgroundImageOpacity: 'opacity-06',
  enablePageTitleIcon: true,
  enablePageTitleSubheading: true,
  enablePageTabsAlt: true,
};

const themeOptionsSlice = createSlice({
  name: 'themeOptions',
  initialState,
  reducers: {
    setEnableBackgroundImage: (state, action) => {
      state.enableBackgroundImage = action.payload;
    },
    setEnableFixedHeader: (state, action) => {
      state.enableFixedHeader = action.payload;
    },
    setEnableHeaderShadow: (state, action) => {
      state.enableHeaderShadow = action.payload;
    },
    setEnableSidebarShadow: (state, action) => {
      state.enableSidebarShadow = action.payload;
    },
    setEnablePageTitleIcon: (state, action) => {
      state.enablePageTitleIcon = action.payload;
    },
    setEnablePageTitleSubheading: (state, action) => {
      state.enablePageTitleSubheading = action.payload;
    },
    setEnablePageTabsAlt: (state, action) => {
      state.enablePageTabsAlt = action.payload;
    },
    setEnableFixedSidebar: (state, action) => {
      state.enableFixedSidebar = action.payload;
    },
    setEnableClosedSidebar: (state, action) => {
      state.enableClosedSidebar = action.payload;
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(CLOSED_SIDEBAR_STORAGE_KEY, action.payload ? '1' : '0');
        }
      } catch (_) {}
    },
    setEnableMobileMenu: (state, action) => {
      state.enableMobileMenu = action.payload;
    },
    setEnableMobileMenuSmall: (state, action) => {
      state.enableMobileMenuSmall = action.payload;
    },
    setEnableFixedFooter: (state, action) => {
      state.enableFixedFooter = action.payload;
    },
    setBackgroundColor: (state, action) => {
      state.backgroundColor = action.payload;
    },
    setHeaderBackgroundColor: (state, action) => {
      state.headerBackgroundColor = action.payload;
    },
    setColorScheme: (state, action) => {
      state.colorScheme = action.payload;
    },
    setBackgroundImageOpacity: (state, action) => {
      state.backgroundImageOpacity = action.payload;
    },
    setBackgroundImage: (state, action) => {
      state.backgroundImage = action.payload;
    },
  },
});

// Export action creators
export const {
  setEnableBackgroundImage,
  setEnableFixedHeader,
  setEnableHeaderShadow,
  setEnableSidebarShadow,
  setEnablePageTitleIcon,
  setEnablePageTitleSubheading,
  setEnablePageTabsAlt,
  setEnableFixedSidebar,
  setEnableClosedSidebar,
  setEnableMobileMenu,
  setEnableMobileMenuSmall,
  setEnableFixedFooter,
  setBackgroundColor,
  setHeaderBackgroundColor,
  setColorScheme,
  setBackgroundImageOpacity,
  setBackgroundImage,
} = themeOptionsSlice.actions;

// Export selectors
export const selectThemeOptions = (state) => state.ThemeOptions;
export const selectBackgroundImage = (state) => state.ThemeOptions.backgroundImage;
export const selectColorScheme = (state) => state.ThemeOptions.colorScheme;
export const selectEnableFixedHeader = (state) => state.ThemeOptions.enableFixedHeader;

// Export reducer
export default themeOptionsSlice.reducer;

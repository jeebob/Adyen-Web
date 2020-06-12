import * as logger from '../utilities/logger';
import createIframe from '../utilities/createIframe';
import { selectOne, on, off, removeAllChildren } from '../utilities/dom';
import postMessageToIframe from './utils/iframes/postMessageToIframe';
import { isWebpackPostMsg, originCheckPassed, isChromeVoxPostMsg } from './utils/iframes/postMessageValidation';
import { ENCRYPTED_SECURITY_CODE, IFRAME_TITLE } from '../configuration/constants';
import { generateRandomNumber } from '../utilities/commonUtils';
import { SFFeedbackObj } from '~/components/internal/SecuredFields/lib/types';
import AbstractSecuredField, {
    SFSetupObject,
    IframeConfigObject,
    RtnType_noParamVoidFn,
    RtnType_postMessageListener,
    RtnType_callbackFn
} from '~/components/internal/SecuredFields/lib/core/AbstractSecuredField';
import { pick, reject } from '~/components/internal/SecuredFields/utils';
import getProp from '~/utils/getProp';

const logPostMsg = false;
const doLog = false;

class SecuredField extends AbstractSecuredField {
    // --
    constructor(pSetupObj: SFSetupObject) {
        super();

        // List of props from setup object not needed for iframe config
        const deltaPropsArr: string[] = ['fieldType', 'cvcRequired', 'iframeSrc', 'loadingContext', 'holderEl'];

        // Copy passed setup object values to this.config
        const configVarsFromSetUpObj = reject(deltaPropsArr).from(pSetupObj);
        this.config = { ...this.config, ...configVarsFromSetUpObj };

        // Copy passed setup object values to this
        const thisVarsFromSetupObj = pick(deltaPropsArr).from(pSetupObj);

        this.fieldType = thisVarsFromSetupObj.fieldType;
        this.cvcRequired = thisVarsFromSetupObj.cvcRequired;
        this.iframeSrc = thisVarsFromSetupObj.iframeSrc;
        this.loadingContext = thisVarsFromSetupObj.loadingContext;
        this.holderEl = thisVarsFromSetupObj.holderEl;

        // Initiate values through setters
        this.isValid = false;
        this.iframeContentWindow = null;
        this.numKey = generateRandomNumber();
        this.isEncrypted = false;
        this.hasError = false;
        this.errorType = '';

        if (process.env.NODE_ENV === 'development' && doLog) {
            logger.log('### SecuredFieldCls::constructor:: this.fieldType=', this.fieldType, 'isValid=', this._isValid, 'numKey=', this.numKey);
            logger.log('\n');
        }

        return this.init();
    }

    init(): SecuredField {
        const iframeTitle: string = getProp(this.config, `pmConfig.ariaLabels.${this.fieldType}.iframeTitle`) || IFRAME_TITLE;

        const iframeEl: HTMLIFrameElement = createIframe(`${this.iframeSrc}`, iframeTitle);

        // Place the iframe into the holder
        this.holderEl.appendChild(iframeEl);

        // Now examine the holder to get an actual DOM node
        const iframe: HTMLIFrameElement = selectOne(this.holderEl, '.js-iframe');

        if (iframe) {
            this.iframeContentWindow = iframe.contentWindow;

            // Create reference to bound fn (see getters/setters for binding)
            this.iframeOnLoadListener = this.iframeOnLoadListenerFn;

            on(iframe, 'load', this.iframeOnLoadListener, false);
        }

        return this;
    }

    iframeOnLoadListenerFn(): void {
        if (process.env.NODE_ENV === 'development' && window._b$dl) {
            logger.log('\n############################');
            logger.log('### SecuredFieldCls:::: onIframeLoaded:: this type=', this.config.txVariant);
        }

        off(window, 'load', this.iframeOnLoadListener, false);

        // Create reference to bound fn (see getters/setters for binding)
        this.postMessageListener = this.postMessageListenerFn;

        // Add general listener for 'message' EVENT - the event that 'powers' postMessage
        on(window, 'message', this.postMessageListener, false);

        // Create and send config object to iframe
        const configObj: IframeConfigObject = {
            fieldType: this.fieldType,
            cvcRequired: this.cvcRequired,
            numKey: this.numKey,
            txVariant: this.config.txVariant,
            extraFieldData: this.config.extraFieldData,
            cardGroupTypes: this.config.cardGroupTypes,
            iframeUIConfig: this.config.iframeUIConfig,
            pmConfig: this.config.iframeUIConfig, // TODO - only needed until latest version of 3.2.2 is on test
            sfLogAtStart: this.config.sfLogAtStart,
            showWarnings: this.config.showWarnings,
            trimTrailingSeparator: this.config.trimTrailingSeparator,
            isCreditCardType: this.config.isCreditCardType
        };

        if (process.env.NODE_ENV === 'development' && window._b$dl) {
            logger.log('### SecuredFieldCls:::: onIframeLoaded:: created configObj=', configObj);
        }

        postMessageToIframe(configObj, this.iframeContentWindow, this.loadingContext);
        //--

        // Callback to say iframe loaded
        this.onIframeLoadedCallback();
    }

    postMessageListenerFn(event: MessageEvent): void {
        // Check message is from expected domain
        if (!originCheckPassed(event, this.loadingContext, this.config.showWarnings)) {
            return;
        }

        // TODO - for debugging purposes this would always be useful to see
        //        logger.log('\n',this.fieldType,'### CSF SecuredFieldCls::postMessageListener:: event.data=',event.data);

        if (process.env.NODE_ENV === 'development' && logPostMsg) {
            logger.log(
                '\n###CSF SecuredFieldCls::postMessageListener:: DOMAIN & ORIGIN MATCH, NO WEBPACK WEIRDNESS fieldType=',
                this.fieldType,
                'txVariant=',
                this.config.txVariant,
                'this.numKey=',
                this.numKey
            );
        }

        // PARSE DATA OBJECT (thus testing if it is a JSON string) - OR TRY & WORK OUT WHY THE PARSING FAILED
        let feedbackObj: SFFeedbackObj;

        try {
            feedbackObj = JSON.parse(event.data);
        } catch (e) {
            // Was the message generated by webpack?
            if (isWebpackPostMsg(event)) {
                if (this.config.showWarnings) logger.log('### SecuredFieldCls::postMessageListenerFn:: PARSE FAIL - WEBPACK');
                return;
            }

            // Was the message generated by ChromeVox?
            if (isChromeVoxPostMsg(event)) {
                if (this.config.showWarnings) logger.log('### SecuredFieldCls::postMessageListenerFn:: PARSE FAIL - CHROMEVOX');
                return;
            }

            if (this.config.showWarnings)
                logger.log('### SecuredFieldCls::postMessageListenerFn:: PARSE FAIL - UNKNOWN REASON: event.data=', event.data);
            return;
        }

        // CHECK FOR EXPECTED PROPS
        const hasMainProps: boolean =
            Object.prototype.hasOwnProperty.call(feedbackObj, 'action') && Object.prototype.hasOwnProperty.call(feedbackObj, 'numKey');

        if (!hasMainProps) {
            if (this.config.showWarnings) logger.warn('WARNING SecuredFieldCls :: postMessage listener for iframe :: data mismatch!');
            return;
        }

        if (process.env.NODE_ENV === 'development' && logPostMsg) {
            logger.log('### SecuredFieldCls::postMessageListener:: feedbackObj.numKey=', feedbackObj.numKey);
        }

        if (this.numKey !== feedbackObj.numKey) {
            if (this.config.showWarnings) {
                logger.warn(
                    'WARNING SecuredFieldCls :: postMessage listener for iframe :: data mismatch! ' +
                        '(Probably a message from an unrelated securedField)'
                );
            }
            return;
        }

        // VALIDATION CHECKS PASSED - DECIDE ON COURSE OF ACTION
        if (process.env.NODE_ENV === 'development' && logPostMsg) {
            logger.log(
                '### SecuredFieldCls::postMessageListener:: numkeys match PROCEED WITH POST MESSAGE PROCESSING fieldType=',
                this.fieldType,
                'txVariant=',
                this.config.txVariant
            );
        }

        switch (feedbackObj.action) {
            case 'encryption':
                this.isValid = true;
                this.onEncryptionCallback(feedbackObj);
                break;

            case 'config':
                this.onConfigCallback();
                break;

            case 'focus':
                this.onFocusCallback(feedbackObj);
                break;

            case 'binValue':
                this.onBinValueCallback(feedbackObj);
                break;

            // iOS ONLY - RE. iOS BUGS AROUND BLUR AND FOCUS EVENTS
            case 'click':
                this.onClickCallback(feedbackObj);
                break;

            // Only happens for Firefox & IE <= 11
            case 'shifttab':
                this.onShiftTabCallback(feedbackObj);
                break;

            case 'autoComplete':
                this.onAutoCompleteCallback(feedbackObj);
                break;

            /**
             * Validate, because action=
             *  'numberKeyPressed' or date-, month-, year-, cvc-, pin-, or iban- KeyPressed (i.e. regular, "non-error" event)
             *  'delete'
             *  'luhnCheck'
             *  'brand'
             *  'incomplete field' (follows from a focus (blur) event)
             */
            default:
                // If we're validation handling (& not encryption handling) field must be invalid
                this.isValid = false;
                this.onValidationCallback(feedbackObj);
        }
    }

    destroy(): void {
        off(window, 'message', this.postMessageListener, false);
        this.iframeContentWindow = null;
        removeAllChildren(this.holderEl);
    }

    // /////// ALLOCATE CALLBACKS /////////
    onIframeLoaded(callbackFn: RtnType_noParamVoidFn): SecuredField {
        this.onIframeLoadedCallback = callbackFn;
        return this;
    }

    onEncryption(callbackFn: RtnType_callbackFn): SecuredField {
        this.onEncryptionCallback = callbackFn;
        return this;
    }

    onValidation(callbackFn: RtnType_callbackFn): SecuredField {
        this.onValidationCallback = callbackFn;
        return this;
    }

    onConfig(callbackFn: RtnType_noParamVoidFn): SecuredField {
        this.onConfigCallback = callbackFn;
        return this;
    }

    onFocus(callbackFn: RtnType_callbackFn): SecuredField {
        this.onFocusCallback = callbackFn;
        return this;
    }

    onBinValue(callbackFn: RtnType_callbackFn): SecuredField {
        this.onBinValueCallback = callbackFn;
        return this;
    }

    onClick(callbackFn: RtnType_callbackFn): SecuredField {
        this.onClickCallback = callbackFn;
        return this;
    }

    onShiftTab(callbackFn: RtnType_callbackFn): SecuredField {
        this.onShiftTabCallback = callbackFn;
        return this;
    }

    onAutoComplete(callbackFn: RtnType_callbackFn): SecuredField {
        this.onAutoCompleteCallback = callbackFn;
        return this;
    }
    //------------------------------------

    // ///////////// GETTERS/SETTERS //////////////

    get errorType(): string {
        return this._errorType;
    }
    set errorType(value: string) {
        this._errorType = value;
    }

    get hasError(): boolean {
        return this._hasError;
    }
    set hasError(value: boolean) {
        this._hasError = value;
    }

    get isValid(): boolean {
        if (this.fieldType === ENCRYPTED_SECURITY_CODE) {
            if (!this.cvcRequired) {
                // If cvc is optional then the field is always valid UNLESS it has an error
                return !this.hasError;
            }
            return this._isValid && !this.hasError;
        }
        return this._isValid;
    }
    set isValid(value: boolean) {
        this._isValid = value;
    }

    get cvcRequired(): boolean {
        return this._cvcRequired;
    }
    set cvcRequired(value: boolean) {
        // Only set if this is a CVC field
        if (this.fieldType !== ENCRYPTED_SECURITY_CODE) return;

        // Only set if value has changed
        if (value === this.cvcRequired) return;

        if (process.env.NODE_ENV === 'development' && doLog) logger.log(this.fieldType, '### SecuredFieldCls::cvcRequired:: value=', value);

        this._cvcRequired = value;

        // If the field has changed status (required <--> not required) AND it's error state was due to an isValidated call
        // NOTE: fixes issue in Components where you first validate and then start typing a maestro number
        // - w/o this and the fix in CSF the maestro PM will never register as valid
        if (this.hasError && this.errorType === 'isValidated') {
            this.hasError = false;
        }
    }

    get iframeContentWindow(): Window {
        return this._iframeContentWindow;
    }
    set iframeContentWindow(value: Window) {
        this._iframeContentWindow = value;
    }

    get isEncrypted(): boolean {
        return this._isEncrypted;
    }
    set isEncrypted(value: boolean) {
        this._isEncrypted = value;
    }

    get numKey(): number {
        return this._numKey;
    }
    set numKey(value: number) {
        this._numKey = value;
    }

    // Internal use - way to create listener refs that we can add/remove
    get iframeOnLoadListener(): RtnType_noParamVoidFn {
        return this._iframeOnLoadListener;
    }
    set iframeOnLoadListener(value: RtnType_noParamVoidFn) {
        this._iframeOnLoadListener = value.bind(this);
    }

    get postMessageListener(): RtnType_postMessageListener {
        return this._postMessageListener;
    }
    set postMessageListener(value: RtnType_postMessageListener) {
        this._postMessageListener = value.bind(this);
    }
}

export default SecuredField;

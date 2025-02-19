/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import debounce from 'lodash/debounce';
import {CredentialsManager} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {responseJson} from 'neuroglancer/util/http_request';
import {urlSafeParse, verifyObject} from 'neuroglancer/util/json';
import {cancellableFetchSpecialOk, parseSpecialUrl} from 'neuroglancer/util/special_protocol_request';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';

/**
 * @file Implements a binding between a Trackable value and the URL hash state.
 */

/**
 * Encodes a fragment string robustly.
 */
function encodeFragment(fragment: string) {
  return encodeURI(fragment).replace(/[!'()*;,]/g, function(c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

export function removeParameterFromUrl(url: string, parameter: string) {
  return url.replace(new RegExp('[?&]' + parameter + '=[^&#]*(#.*)?$'), '$1')
      .replace(new RegExp('([?&])' + parameter + '=[^&]*&'), '$1');
}
/**
 * An instance of this class manages a binding between a Trackable value and the URL hash state.
 * The binding is initialized in the constructor, and is removed when dispose is called.
 */
export class UrlHashBinding extends RefCounted {
  /**
   * Most recently parsed or set state string.
   */
  private prevStateString: string|undefined;

  /**
   * Generation number of previous state set.
   */
  private prevStateGeneration: number|undefined;

  /**
   * Most recent error parsing URL hash.
   */
  parseError = new WatchableValue<Error|undefined>(undefined);

  constructor(
      public root: Trackable, public credentialsManager: CredentialsManager,
      updateDelayMilliseconds = 200) {
    super();
    this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
    const throttledSetUrlHash = debounce(() => this.setUrlHash(), updateDelayMilliseconds);
    this.registerDisposer(root.changed.add(throttledSetUrlHash));
    this.registerDisposer(() => throttledSetUrlHash.cancel());
  }

  /**
   * Sets the URL hash to match the current state.
   */
  setUrlHash() {
    const cacheState = getCachedJson(this.root);
    const {generation} = cacheState;
    history.replaceState(null, '', removeParameterFromUrl(window.location.href, 'json_url'));

    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      let stateString = encodeFragment(JSON.stringify(cacheState.value));
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        if (decodeURIComponent(stateString) === '{}') {
          history.replaceState(null, '', '#');
        } else {
          history.replaceState(null, '', '#!' + stateString);
        }
      }
    }
  }


  /**
   * Extract the proper URL string after a Keycloak redirect.
   * Keycloak will place the original fragment in the redirect_fragment
   * query parameter and add another query parameter.
   *
   * Return a tuple with the first value being true if the redirect_fragment
   * was present.  The second value will contain that fragment with '#'
   * prepended.
   */
  checkRedirectFragment(): [boolean, string] {
    const justQuery = location.href.replace(/^.*\?/, '');
    const params = new URLSearchParams(justQuery);
    if(!params.has('redirect_fragment')) {
      return [false, ''];
    }

    return [true, `#${params.get('redirect_fragment')}`];
  }

  /**
   * Sets the current state to match the URL hash.  If it is desired to initialize the state based
   * on the URL hash, then this should be called immediately after construction.
   */
  updateFromUrlHash() {
    try {
      let s: string;
      const [ found, fragment ] = this.checkRedirectFragment();
      if(!found) {
        s = location.href.replace(/^[^#]+/, '');
        if (s === '' || s === '#' || s === '#!') {
          s = '#!{}';
        }
      } else {
        s = fragment;
      }
      // Handle remote JSON state
      if (s.match(/^#!([a-z][a-z\d+-.]*):\/\//)) {
        const url = s.substring(2);
        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);
        StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  verifyObject(json);
                  this.root.reset();
                  this.root.restoreState(json);
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading state:`});
      } else if (s.startsWith('#!+')) {
        s = s.slice(3);
        // Firefox always %-encodes the URL even if it is not typed that way.
        s = decodeURIComponent(s);
        if(found) {
          // Keycloak make encode multiple times.
          s = decodeURIComponent(s);
        }
        let state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
        this.prevStateString = undefined;
      } else if (s.startsWith('#!')) {
        s = s.slice(2);
        s = decodeURIComponent(s);
        if(found) {
          // Keycloak make encode multiple times.
          s = decodeURIComponent(s);
        }
        if (s === this.prevStateString) {
          return;
        }
        this.prevStateString = s;
        this.root.reset();
        let state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
      } else {
        throw new Error(`URL hash is expected to be of the form "#!{...}" or "#!+{...}".`);
      }
      this.parseError.value = undefined;
    } catch (parseError) {
      this.parseError.value = parseError;
    }
  }
}

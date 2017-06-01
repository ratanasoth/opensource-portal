//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

const async = require('async');
const Q = require('q');

const composite = require('./composite');
const core = require('./core');

function createMethods(libraryContext, collectionsClient) {
  function generalizedCollectionMethod(token, apiName, method, options, cacheOptions, callback) {
    if (callback === undefined && typeof (cacheOptions) === 'function') {
      callback = cacheOptions;
      cacheOptions = {};
    }
    const apiContext = composite.create(apiName, method, options);
    apiContext.maxAgeSeconds = cacheOptions.maxAgeSeconds || 600;
    apiContext.token = token;
    apiContext.libraryContext = libraryContext;
    if (cacheOptions.backgroundRefresh) {
      apiContext.backgroundRefresh = true;
    }
    return core.execute(apiContext, callback);
  }

  function getCrossOrganizationMethod(orgsAndTokens, apiName, methodName, options, cacheOptions, callback) {
    const method = collectionsClient[methodName];
    if (!method) {
      throw new Error(`No method called ${method} defined in the collections client.`);
    }
    const crossOrgMethod = function () {
      const values = {};
      values.meta = {};
      values.orgs = {};
      const deferred = Q.defer();
      async.eachOfLimit(orgsAndTokens, 1, (token, orgName, next) => {
        const localOptions = Object.assign({}, options);
        localOptions.org = orgName;
        if (!localOptions.per_page) {
          localOptions.per_page = 100;
        }
        const localCacheOptions = Object.assign({}, cacheOptions);
        if (localCacheOptions.individualMaxAgeSeconds) {
          localCacheOptions.maxAgeSeconds = localCacheOptions.individualMaxAgeSeconds;
        }
        method(token, localOptions, localCacheOptions, (orgError, orgValues) => {
          if (orgError) {
            return next(orgError);
          }
          values.orgs[orgName] = orgValues;
          return next();
        });
      }, (error) => {
        if (error) {
          return deferred.reject(error);
        }
        deferred.resolve(values);
      });
      return deferred.promise;
    };
    return generalizedCollectionMethod(orgsAndTokens, apiName, crossOrgMethod, options, cacheOptions, callback);
  }

  function crossOrganizationCollection(orgsAndTokens, options, cacheOptions, innerKeyType, outerFunction, collectionMethodName, collectionKey, optionalSetOrganizationLogin) {
    return () => {
      const deferred = Q.defer();
      const entities = [];
      entities.meta = {};
      outerFunction(orgsAndTokens, {}, cacheOptions, (outerError, entitiesByOrg) => {
        if (outerError) {
          return deferred.reject(outerError);
        }
        const localCacheOptions = Object.assign({}, cacheOptions);
        if (localCacheOptions.individualMaxAgeSeconds) {
          localCacheOptions.maxAgeSeconds = localCacheOptions.individualMaxAgeSeconds;
        }
        entities.meta = {};
        async.eachLimit(Object.getOwnPropertyNames(entitiesByOrg.orgs), 1, (orgName, nextOrg) => {
          const orgEntities = entitiesByOrg.orgs[orgName];
          async.eachLimit(orgEntities, 1, (orgEntity, next) => {
            const cloneTarget = optionalSetOrganizationLogin ? {
              organization: {
                login: orgName,
              }
            } : {};
            const entityClone = Object.assign(cloneTarget, orgEntity);
            const localOptionsTarget = {
              per_page: 100,
            };
            switch (innerKeyType) {
            case 'team':
              localOptionsTarget.id = orgEntity.id;
              break;
            case 'repo':
              localOptionsTarget.owner = orgName;
              localOptionsTarget.repo = orgEntity.name;
              break;
            default:
              throw new Error(`Unsupported inner key type ${innerKeyType}`);
            }
            const localOptions = Object.assign(localOptionsTarget, options);
            delete localOptions.maxAgeSeconds;
            delete localOptions.backgroundRefresh;
            const token = orgsAndTokens[orgName];
            if (!token) {
              return next(new Error(`No token available for the org "${orgName}"`));
            }
            collectionsClient[collectionMethodName](token, localOptions, localCacheOptions, (collectionsError, innerEntities) => {
              // This is a silent error for now, because there
              // are valid scenarios, i.e. team deletion, to consider.
              // In the future, get smarter here.
              if (collectionsError) {
                return next();
              }
              entityClone[collectionKey] = innerEntities;
              entities.push(entityClone);
              return next();
            });
          }, nextOrg);
        }, (error) => {
          return error ? deferred.reject(error) : deferred.resolve(entities);
        });
      });
      return deferred.promise;
    };
  }

  function getAllTeams(orgsAndTokens, options, cacheOptions, callback) {
    options.apiTypePrefix = 'github.x#';
    return getCrossOrganizationMethod(orgsAndTokens, 'teams', 'getOrgTeams', options, cacheOptions, callback);
  }
  function getAllRepos(orgsAndTokens, options, cacheOptions, callback) {
    options.apiTypePrefix = 'github.x#';
    return getCrossOrganizationMethod(orgsAndTokens, 'repos', 'getOrgRepos', options, cacheOptions, callback);
  }
  return {
    orgMembers: function getAllMembers(orgsAndTokens, options, cacheOptions, callback) {
      options.apiTypePrefix = 'github.x#';
      return getCrossOrganizationMethod(orgsAndTokens, 'orgMembers', 'getOrgMembers', options, cacheOptions, callback);
    },
    teams: getAllTeams,
    teamMembers: function getAllTeamMembers(orgsAndTokens, options, cacheOptions, callback) {
      options.apiTypePrefix = 'github.x#';
      return generalizedCollectionMethod(orgsAndTokens, 'teamMembers',
      crossOrganizationCollection(orgsAndTokens, options, cacheOptions, 'team', getAllTeams, 'getTeamMembers', 'members', true),
      options, cacheOptions, callback);
    },
    repos: getAllRepos,
    repoCollaborators: function getAllRepoCollaborators(orgsAndTokens, options, cacheOptions, callback) {
      options.apiTypePrefix = 'github.x#';
      return generalizedCollectionMethod(orgsAndTokens, 'repoCollaborators',
      crossOrganizationCollection(orgsAndTokens, options, cacheOptions, 'repo', getAllRepos, 'getRepoCollaborators', 'collaborators', true),
      options, cacheOptions, callback);
    },
    repoTeams: function getAllRepoTeams(orgsAndTokens, options, cacheOptions, callback) {
      options.apiTypePrefix = 'github.x#';
      return generalizedCollectionMethod(
        orgsAndTokens,
        'repoTeams',
        crossOrganizationCollection(orgsAndTokens, options, cacheOptions, 'repo', getAllRepos, 'getRepoTeams', 'teams', true),
        options,
        cacheOptions,
        callback);
    },
  };
}

module.exports = createMethods;
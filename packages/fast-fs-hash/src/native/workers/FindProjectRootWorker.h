/**
 * FindProjectRootWorker: async worker that runs walkProjectRoot() on a pool thread.
 *
 * The walk is stat-bound and typically takes tens of microseconds — close to
 * the cost of thread-pool dispatch itself. The async variant exists mainly to
 * avoid blocking the JS thread on pathologically slow filesystems (network
 * mounts, cold caches). The sync binding is the recommended default.
 */

#ifndef _FAST_FS_HASH_FIND_PROJECT_ROOT_WORKER_H
#define _FAST_FS_HASH_FIND_PROJECT_ROOT_WORKER_H

#include "../find-project-root-core.h"
#include "../core/AddonWorker.h"

namespace fast_fs_hash {

  /** Build a JS ProjectRoot object from a ProjectRootResult using the napi C API.
   *  Avoids per-key `Napi::Object::Set` overhead by pre-computing property names
   *  once and writing them via `napi_set_named_property`. */
  inline napi_value buildProjectRootObject(napi_env env, const ProjectRootResult & r) noexcept {
    napi_value obj;
    if (napi_create_object(env, &obj) != napi_ok) {
      return nullptr;
    }

    auto setField = [&](const char * key, const std::string & value) noexcept {
      napi_value v;
      if (value.empty()) {
        napi_get_null(env, &v);
      } else {
        if (napi_create_string_utf8(env, value.data(), value.size(), &v) != napi_ok) {
          napi_get_null(env, &v);
        }
      }
      napi_set_named_property(env, obj, key, v);
    };

    setField("gitRoot", r.gitRoot);
    setField("gitSuperRoot", r.gitSuperRoot);
    setField("nearestPackageJson", r.nearestPackageJson);
    setField("rootPackageJson", r.rootPackageJson);
    setField("nearestTsconfigJson", r.nearestTsconfigJson);
    setField("rootTsconfigJson", r.rootTsconfigJson);
    setField("nearestNodeModules", r.nearestNodeModules);
    setField("rootNodeModules", r.rootNodeModules);

    return obj;
  }

  class FindProjectRootWorker final : public AddonWorker {
   public:
    FindProjectRootWorker(
        Napi::Env env, Napi::Promise::Deferred deferred,
        std::string startPath, std::string homePath, std::string stopPath) :
      AddonWorker(env, deferred),
      startPath_(std::move(startPath)),
      homePath_(std::move(homePath)),
      stopPath_(std::move(stopPath)) {}

    void Execute() override {
      walkProjectRoot(
        this->startPath_.c_str(), this->homePath_.c_str(), this->stopPath_.c_str(), this->result_);
      if (this->result_.error) {
        this->signal(this->result_.error);
        return;
      }
      this->signal();
    }

    void OnOK() override {
      napi_value obj = buildProjectRootObject(this->env, this->result_);
      if (!obj) {
        this->deferred.Reject(Napi::Error::New(Napi::Env(this->env), "findProjectRoot: failed to build result object").Value());
        return;
      }
      this->deferred.Resolve(Napi::Value(this->env, obj));
    }

   private:
    std::string startPath_;
    std::string homePath_;
    std::string stopPath_;
    ProjectRootResult result_;
  };

}  // namespace fast_fs_hash

#endif

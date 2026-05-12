/**
 * FindNearestProjectFilesWorker: async worker that runs walkNearestProjectFiles()
 * on the compute pool. The walk is stat-bound and typically completes in a few
 * microseconds with early-exit, so the async variant exists mainly to avoid
 * blocking the JS thread on slow filesystems.
 */

#ifndef _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_WORKER_H
#define _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_WORKER_H

#include "../find-nearest-project-files-core.h"
#include "../core/AddonWorker.h"

namespace fast_fs_hash {

  /** Build a JS NearestProjectFiles object from a NearestProjectFilesResult.
   *  Uses the napi C API directly to avoid per-key Napi::Object::Set overhead. */
  inline napi_value buildNearestProjectFilesObject(napi_env env, const NearestProjectFilesResult & r) noexcept {
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

    setField("packageJson", r.packageJson);
    setField("tsconfigJson", r.tsconfigJson);
    setField("nodeModules", r.nodeModules);

    return obj;
  }

  class FindNearestProjectFilesWorker final : public AddonWorker {
   public:
    FindNearestProjectFilesWorker(
        Napi::Env env, Napi::Promise::Deferred deferred,
        std::string startPath, std::string homePath, std::string stopPath) :
      AddonWorker(env, deferred),
      startPath_(std::move(startPath)),
      homePath_(std::move(homePath)),
      stopPath_(std::move(stopPath)) {}

    void Execute() override {
      walkNearestProjectFiles(
        this->startPath_.c_str(), this->homePath_.c_str(), this->stopPath_.c_str(), this->result_);
      if (this->result_.error) {
        this->signal(this->result_.error);
        return;
      }
      this->signal();
    }

    void OnOK() override {
      napi_value obj = buildNearestProjectFilesObject(this->env, this->result_);
      if (!obj) {
        this->deferred.Reject(Napi::Error::New(
          Napi::Env(this->env), "findNearestProjectFiles: failed to build result object").Value());
        return;
      }
      this->deferred.Resolve(Napi::Value(this->env, obj));
    }

   private:
    std::string startPath_;
    std::string homePath_;
    std::string stopPath_;
    NearestProjectFilesResult result_;
  };

}  // namespace fast_fs_hash

#endif
